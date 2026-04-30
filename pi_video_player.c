#define _GNU_SOURCE

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wiringPi.h>
#include <wiringPiSPI.h>

#define SPI_MODE 0
#define NUM_SPI_BUS 2
#define SPI_CHAN 0
#define NUM_LED_PER_KEYBOARD 89
#define NUM_KEYBOARD 10
#define NUM_LEDS_PER_STAND (NUM_LED_PER_KEYBOARD * NUM_KEYBOARD)
#define NUM_BYTE_PER_LED 4
#define NUM_START_FRAME_BYTE 4
#define NUM_END_FRAME_BYTE 4
#define NUM_BYTES ((NUM_LEDS_PER_STAND * NUM_BYTE_PER_LED) + NUM_START_FRAME_BYTE + NUM_END_FRAME_BYTE)
#define SPI_MHZ 9
#define GLOBAL_BYTE 0b11100010
#define FRAME_BITS_PER_LED 32
#define DELIMITER_BITS (NUM_START_FRAME_BYTE * 8)

typedef struct
{
  int bus;
  uint8_t *myData;
  size_t myData_len;
} thread_data;

static const int SPI_BUSES[NUM_SPI_BUS] = {0, 6};

static volatile sig_atomic_t keepRunning = 1;

static uint8_t values_0[NUM_BYTES];
static uint8_t values_1[NUM_BYTES];
static uint8_t g_startFrame[NUM_START_FRAME_BYTE];
static uint8_t g_endFrame[NUM_END_FRAME_BYTE];

static void handleSignal(int signo)
{
  (void)signo;
  keepRunning = 0;
}

static void *sendSpi(void *dataPtr)
{
  thread_data *data = (thread_data *)dataPtr;

  if (wiringPiSPIxDataRW(data->bus, SPI_CHAN, data->myData, (int)data->myData_len) == -1)
  {
    fprintf(stderr, "SPI bus %d failure: %s\n", data->bus, strerror(errno));
  }

  return NULL;
}

static void spiSetup(int speed)
{
  for (int i = 0; i < NUM_SPI_BUS; i++)
  {
    int bus = SPI_BUSES[i];
    if (wiringPiSPIxSetupMode(bus, SPI_CHAN, speed, SPI_MODE) < 0)
    {
      fprintf(stderr, "Cannot open SPI bus %d: %s\n", bus, strerror(errno));
      exit(EXIT_FAILURE);
    }
  }
}

static long timeDiffMicroseconds(struct timespec start, struct timespec end)
{
  return (end.tv_sec - start.tv_sec) * 1000000L + (end.tv_nsec - start.tv_nsec) / 1000L;
}

static int bitsToByte(const char *p)
{
  int v = 0;
  for (int i = 0; i < 8; i++)
  {
    if (p[i] != '0' && p[i] != '1')
    {
      return -1;
    }
    v = (v << 1) | (p[i] - '0');
  }
  return v;
}

static int decodeLineToBytes(const char *line, ssize_t len, uint8_t *out, int numBytes)
{
  if (len < numBytes * 8)
  {
    return -1;
  }
  for (int i = 0; i < numBytes; i++)
  {
    int b = bitsToByte(line + i * 8);
    if (b < 0)
    {
      return -1;
    }
    out[i] = (uint8_t)b;
  }
  return 0;
}

static int decodeFrameLineToValues(const char *line, size_t frameLedCount, uint8_t *values)
{
  size_t ledLimit = frameLedCount;

  if (ledLimit > NUM_LEDS_PER_STAND)
  {
    ledLimit = NUM_LEDS_PER_STAND;
  }

  memcpy(values, g_startFrame, NUM_START_FRAME_BYTE);

  for (size_t led = 0; led < ledLimit; led++)
  {
    const char *chunk = line + (led * FRAME_BITS_PER_LED);
    int b0 = bitsToByte(chunk + 0);
    int b1 = bitsToByte(chunk + 8);
    int b2 = bitsToByte(chunk + 16);
    int b3 = bitsToByte(chunk + 24);
    size_t offset = NUM_START_FRAME_BYTE + (led * NUM_BYTE_PER_LED);

    if (b0 < 0 || b1 < 0 || b2 < 0 || b3 < 0)
    {
      return -1;
    }

    values[offset + 0] = (uint8_t)b0;
    values[offset + 1] = (uint8_t)b1;
    values[offset + 2] = (uint8_t)b2;
    values[offset + 3] = (uint8_t)b3;
  }

  for (size_t led = ledLimit; led < NUM_LEDS_PER_STAND; led++)
  {
    size_t offset = NUM_START_FRAME_BYTE + (led * NUM_BYTE_PER_LED);
    values[offset + 0] = GLOBAL_BYTE;
    values[offset + 1] = 0x00;
    values[offset + 2] = 0x00;
    values[offset + 3] = 0x00;
  }

  memcpy(values + NUM_BYTES - NUM_END_FRAME_BYTE, g_endFrame, NUM_END_FRAME_BYTE);

  return 0;
}

static int trimLine(char *line, ssize_t *len)
{
  while (*len > 0 && (line[*len - 1] == '\n' || line[*len - 1] == '\r'))
  {
    (*len)--;
  }

  line[*len] = '\0';
  return (*len > 0) ? 0 : -1;
}

int main(int argc, char **argv)
{
  const char *videoFilePath = (argc > 1) ? argv[1] : "videoFile.txt";
  FILE *vf = NULL;
  pthread_t threads[NUM_SPI_BUS];
  thread_data data[NUM_SPI_BUS];
  struct timespec start;
  struct timespec end;

  char *line = NULL;
  size_t cap = 0;
  ssize_t n = 0;
  size_t frameLedCount = 0;

  signal(SIGINT, handleSignal);
  signal(SIGTERM, handleSignal);

  vf = fopen(videoFilePath, "r");
  if (!vf)
  {
    fprintf(stderr, "Cannot open %s: %s\n", videoFilePath, strerror(errno));
    return 1;
  }

  // Read start frame from line 1
  n = getline(&line, &cap, vf);
  if (n <= 0 || trimLine(line, &n) != 0)
  {
    fprintf(stderr, "Missing start frame in %s\n", videoFilePath);
    fclose(vf);
    return 1;
  }
  if (n != DELIMITER_BITS || decodeLineToBytes(line, n, g_startFrame, NUM_START_FRAME_BYTE) != 0)
  {
    fprintf(stderr, "Invalid start frame in %s (expected %d bits)\n", videoFilePath, DELIMITER_BITS);
    fclose(vf);
    return 1;
  }

  // Read first video frame (line 2) to detect LED count
  n = getline(&line, &cap, vf);
  if (n <= 0 || trimLine(line, &n) != 0)
  {
    fprintf(stderr, "No video frames found in %s\n", videoFilePath);
    fclose(vf);
    free(line);
    return 1;
  }
  if ((n % FRAME_BITS_PER_LED) != 0)
  {
    fprintf(stderr, "Invalid frame length: %zd bits\n", n);
    fclose(vf);
    free(line);
    return 1;
  }
  frameLedCount = (size_t)n / FRAME_BITS_PER_LED;
  fprintf(stdout, "Detected %zu LEDs per frame\n", frameLedCount);

  // Scan rest of file to find end frame (last DELIMITER_BITS-wide line)
  memset(g_endFrame, 0xFF, NUM_END_FRAME_BYTE);
  while ((n = getline(&line, &cap, vf)) > 0)
  {
    ssize_t tlen = n;
    while (tlen > 0 && (line[tlen - 1] == '\n' || line[tlen - 1] == '\r'))
    {
      tlen--;
    }
    if (tlen == DELIMITER_BITS)
    {
      decodeLineToBytes(line, tlen, g_endFrame, NUM_END_FRAME_BYTE);
    }
  }

  rewind(vf);

  wiringPiSetup();
  spiSetup(SPI_MHZ * 1000000);

  while (keepRunning)
  {
    clock_gettime(CLOCK_MONOTONIC, &start);

    n = getline(&line, &cap, vf);
    if (n < 0)
    {
      rewind(vf);
      n = getline(&line, &cap, vf);
      if (n < 0)
      {
        break;
      }
    }

    if (trimLine(line, &n) != 0)
    {
      continue;
    }

    // Skip start/end frame delimiter lines silently
    if ((size_t)n == (size_t)DELIMITER_BITS)
    {
      continue;
    }

    if ((size_t)n < frameLedCount * FRAME_BITS_PER_LED)
    {
      fprintf(stderr, "Short frame (%zd bits), skipping\n", n);
      continue;
    }

    if (decodeFrameLineToValues(line, frameLedCount, values_0) != 0)
    {
      fprintf(stderr, "Bad frame data, skipping\n");
      continue;
    }

    memcpy(values_1, values_0, NUM_BYTES);

    data[0].bus = SPI_BUSES[0];
    data[0].myData = values_0;
    data[0].myData_len = NUM_BYTES;

    data[1].bus = SPI_BUSES[1];
    data[1].myData = values_1;
    data[1].myData_len = NUM_BYTES;

    for (int i = 0; i < NUM_SPI_BUS; i++)
    {
      pthread_create(&threads[i], NULL, sendSpi, &data[i]);
    }

    for (int i = 0; i < NUM_SPI_BUS; i++)
    {
      pthread_join(threads[i], NULL);
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    long elapsedUs = timeDiffMicroseconds(start, end);

    if (elapsedUs > 0)
    {
      int fps = (int)(1000000.0 / (double)elapsedUs);
      fprintf(stdout, "FPS: %d\n", fps);
    }
  }

  free(line);
  fclose(vf);
  return 0;
}
