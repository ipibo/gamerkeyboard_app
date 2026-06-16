#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/spi/spidev.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#define NUM_SPI_BUS 4
#define SPI_MODE 0
#define SPI_BITS_PER_WORD 8
#define NUM_BYTE_PER_LED 4
#define NUM_START_FRAME_BYTE 4
#define NUM_END_FRAME_BYTE 56
#define SPI_MHZ 4
#define GLOBAL_BYTE 0b11100001
#define FRAME_BITS_PER_LED 32
#define DELIMITER_BITS (NUM_START_FRAME_BYTE * 8)

/* Raw spidev device node per bus index (guideline mapping). */
static const char *SPI_DEVS[NUM_SPI_BUS] = {
    "/dev/spidev0.0",
    "/dev/spidev3.0",
    "/dev/spidev4.0",
    "/dev/spidev6.0",
};

typedef struct
{
  int busIndex;
  uint8_t *spiData;
  size_t spiDataLen;
} SpiThreadArgs;

typedef struct
{
  FILE *videoFile;
  size_t ledCount;
  size_t spiBufferBytes;
  uint8_t *spiBuffer;
  uint8_t startFrame[NUM_START_FRAME_BYTE];
  uint8_t endFrame[NUM_END_FRAME_BYTE];
  char *lineBuf;
  size_t lineBufCap;
} BusState;

static int spiFd[NUM_SPI_BUS];

static volatile sig_atomic_t keepRunning = 1;

/* Global 5-bit brightness applied at playback. Overrides the low 5 bits of
   each LED's top byte so brightness is set live without re-rendering. Default
   1 (minimum) is the safe floor for hardware testing. */
static int playbackBrightness = 1;
static void handleSignal(int signo)
{
  (void)signo;
  keepRunning = 0;
}

static void *sendSpi(void *argsPtr)
{
  SpiThreadArgs *args = (SpiThreadArgs *)argsPtr;

  struct spi_ioc_transfer transfer = {
      .tx_buf = (unsigned long)args->spiData,
      .len = (uint32_t)args->spiDataLen,
      .speed_hz = SPI_MHZ * 1000000,
      .bits_per_word = SPI_BITS_PER_WORD,
  };

  if (ioctl(spiFd[args->busIndex], SPI_IOC_MESSAGE(1), &transfer) < 0)
  {
    fprintf(stderr, "SPI bus %d (%s) transfer failure: %s\n",
            args->busIndex, SPI_DEVS[args->busIndex], strerror(errno));
  }

  return NULL;
}

static void spiSetup(void)
{
  uint8_t mode = SPI_MODE;
  uint8_t bitsPerWord = SPI_BITS_PER_WORD;
  uint32_t speed = SPI_MHZ * 1000000;

  for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
  {
    int fd = open(SPI_DEVS[busIndex], O_RDWR);
    if (fd < 0)
    {
      fprintf(stderr, "Cannot open %s (bus %d): %s\n",
              SPI_DEVS[busIndex], busIndex, strerror(errno));
      exit(EXIT_FAILURE);
    }

    if (ioctl(fd, SPI_IOC_WR_MODE, &mode) < 0 ||
        ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, &bitsPerWord) < 0 ||
        ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ, &speed) < 0)
    {
      fprintf(stderr, "SPI config failed on %s: %s\n",
              SPI_DEVS[busIndex], strerror(errno));
      exit(EXIT_FAILURE);
    }

    spiFd[busIndex] = fd;
    fprintf(stdout, "opened %s (bus %d) ok\n", SPI_DEVS[busIndex], busIndex);
  }
}

static void sendBuffers(BusState busStates[NUM_SPI_BUS])
{
  pthread_t threads[NUM_SPI_BUS];
  SpiThreadArgs threadArgs[NUM_SPI_BUS];

  for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
  {
    threadArgs[busIndex].busIndex = busIndex;
    threadArgs[busIndex].spiData = busStates[busIndex].spiBuffer;
    threadArgs[busIndex].spiDataLen = busStates[busIndex].spiBufferBytes;
    pthread_create(&threads[busIndex], NULL, sendSpi, &threadArgs[busIndex]);
  }

  for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
  {
    pthread_join(threads[busIndex], NULL);
  }
}

static long timeDiffMicroseconds(struct timespec start, struct timespec end)
{
  return (end.tv_sec - start.tv_sec) * 1000000L + (end.tv_nsec - start.tv_nsec) / 1000L;
}

static int bitsToByte(const char *p)
{
  int byteVal = 0;
  for (int bitIdx = 0; bitIdx < 8; bitIdx++)
  {
    if (p[bitIdx] != '0' && p[bitIdx] != '1')
    {
      return -1;
    }
    byteVal = (byteVal << 1) | (p[bitIdx] - '0');
  }
  return byteVal;
}

static int decodeLineToBytes(const char *line, ssize_t lineLen, uint8_t *out, int numBytes)
{
  if (lineLen < numBytes * 8)
  {
    return -1;
  }
  for (int byteIdx = 0; byteIdx < numBytes; byteIdx++)
  {
    int byteVal = bitsToByte(line + byteIdx * 8);
    if (byteVal < 0)
    {
      return -1;
    }
    out[byteIdx] = (uint8_t)byteVal;
  }
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

static int decodeFrameLineToBuffer(const char *frameLine, BusState *busState)
{
  memcpy(busState->spiBuffer, busState->startFrame, NUM_START_FRAME_BYTE);

  for (size_t ledIndex = 0; ledIndex < busState->ledCount; ledIndex++)
  {
    const char *ledChunk = frameLine + (ledIndex * FRAME_BITS_PER_LED);
    int b0 = bitsToByte(ledChunk + 0);
    int b1 = bitsToByte(ledChunk + 8);
    int b2 = bitsToByte(ledChunk + 16);
    int b3 = bitsToByte(ledChunk + 24);
    size_t byteOffset = NUM_START_FRAME_BYTE + (ledIndex * NUM_BYTE_PER_LED);

    if (b0 < 0 || b1 < 0 || b2 < 0 || b3 < 0)
    {
      return -1;
    }

    /* Keep sign bits (top 3), override brightness (low 5) with live value */
    b0 = (b0 & 0xE0) | (playbackBrightness & 0x1F);

    busState->spiBuffer[byteOffset + 0] = (uint8_t)b0;
    busState->spiBuffer[byteOffset + 1] = (uint8_t)b1;
    busState->spiBuffer[byteOffset + 2] = (uint8_t)b2;
    busState->spiBuffer[byteOffset + 3] = (uint8_t)b3;
  }

  memcpy(
      busState->spiBuffer + busState->spiBufferBytes - NUM_END_FRAME_BYTE,
      busState->endFrame,
      NUM_END_FRAME_BYTE);

  return 0;
}

static void buildBlackFrame(BusState *busState)
{
  memcpy(busState->spiBuffer, busState->startFrame, NUM_START_FRAME_BYTE);

  for (size_t ledIndex = 0; ledIndex < busState->ledCount; ledIndex++)
  {
    size_t byteOffset = NUM_START_FRAME_BYTE + (ledIndex * NUM_BYTE_PER_LED);
    busState->spiBuffer[byteOffset + 0] = GLOBAL_BYTE;
    busState->spiBuffer[byteOffset + 1] = 0x00;
    busState->spiBuffer[byteOffset + 2] = 0x00;
    busState->spiBuffer[byteOffset + 3] = 0x00;
  }

  memcpy(
      busState->spiBuffer + busState->spiBufferBytes - NUM_END_FRAME_BYTE,
      busState->endFrame,
      NUM_END_FRAME_BYTE);
}

/* Reads the next video frame line into busState->lineBuf, skipping delimiter
   lines and rewinding on EOF. Only call when busState->ledCount > 0. */
static ssize_t readNextVideoFrame(BusState *busState)
{
  while (1)
  {
    ssize_t lineLen = getline(&busState->lineBuf, &busState->lineBufCap, busState->videoFile);
    if (lineLen < 0)
    {
      rewind(busState->videoFile);
      continue;
    }
    if (trimLine(busState->lineBuf, &lineLen) != 0)
    {
      continue;
    }
    if ((size_t)lineLen == (size_t)DELIMITER_BITS)
    {
      continue;
    }
    if ((size_t)lineLen < busState->ledCount * FRAME_BITS_PER_LED)
    {
      fprintf(stderr, "Short frame (%zd bits), skipping\n", lineLen);
      continue;
    }
    return lineLen;
  }
}

static int openBusFile(BusState *busState, const char *filePath)
{
  busState->lineBuf = NULL;
  busState->lineBufCap = 0;
  busState->spiBuffer = NULL;
  busState->ledCount = 0;
  busState->videoFile = NULL;

  busState->videoFile = fopen(filePath, "r");
  if (!busState->videoFile)
  {
    fprintf(stderr, "Cannot open %s: %s\n", filePath, strerror(errno));
    return -1;
  }

  // Read start frame
  ssize_t lineLen = getline(&busState->lineBuf, &busState->lineBufCap, busState->videoFile);
  if (lineLen <= 0 || trimLine(busState->lineBuf, &lineLen) != 0)
  {
    fprintf(stderr, "Missing start frame in %s\n", filePath);
    return -1;
  }
  if (lineLen != DELIMITER_BITS || decodeLineToBytes(busState->lineBuf, lineLen, busState->startFrame, NUM_START_FRAME_BYTE) != 0)
  {
    fprintf(stderr, "Invalid start frame in %s (expected %d bits)\n", filePath, DELIMITER_BITS);
    return -1;
  }

  // Read first frame line to detect LED count
  // If it is another DELIMITER_BITS line, this file has zero video frames (zero LEDs)
  lineLen = getline(&busState->lineBuf, &busState->lineBufCap, busState->videoFile);
  if (lineLen <= 0 || trimLine(busState->lineBuf, &lineLen) != 0)
  {
    fprintf(stderr, "No content after start frame in %s\n", filePath);
    return -1;
  }

  memset(busState->endFrame, 0xFF, NUM_END_FRAME_BYTE);

  if (lineLen == DELIMITER_BITS)
  {
    // File has only start+end frames — zero LEDs on this bus
    busState->ledCount = 0;
    decodeLineToBytes(busState->lineBuf, lineLen, busState->endFrame, NUM_END_FRAME_BYTE);
    fprintf(stdout, "%s: zero LEDs (empty bus)\n", filePath);
  }
  else
  {
    if ((lineLen % FRAME_BITS_PER_LED) != 0)
    {
      fprintf(stderr, "Invalid frame length in %s: %zd bits\n", filePath, lineLen);
      return -1;
    }
    busState->ledCount = (size_t)lineLen / FRAME_BITS_PER_LED;
    fprintf(stdout, "%s: detected %zu LEDs per frame\n", filePath, busState->ledCount);

    // Scan remaining lines to find end frame
    while ((lineLen = getline(&busState->lineBuf, &busState->lineBufCap, busState->videoFile)) > 0)
    {
      ssize_t trimmedLen = lineLen;
      while (trimmedLen > 0 && (busState->lineBuf[trimmedLen - 1] == '\n' || busState->lineBuf[trimmedLen - 1] == '\r'))
      {
        trimmedLen--;
      }
      if (trimmedLen == DELIMITER_BITS)
      {
        decodeLineToBytes(busState->lineBuf, trimmedLen, busState->endFrame, NUM_END_FRAME_BYTE);
      }
    }
  }

  // Allocate SPI buffer sized to actual LED count for this bus
  busState->spiBufferBytes = NUM_START_FRAME_BYTE + busState->ledCount * NUM_BYTE_PER_LED + NUM_END_FRAME_BYTE;
  busState->spiBuffer = calloc(busState->spiBufferBytes, 1);
  if (!busState->spiBuffer)
  {
    fprintf(stderr, "Out of memory for SPI buffer (%s)\n", filePath);
    return -1;
  }

  if (busState->ledCount == 0)
  {
    // Pre-build static start+end buffer for zero-LED bus — reused every frame
    memcpy(busState->spiBuffer, busState->startFrame, NUM_START_FRAME_BYTE);
    memcpy(busState->spiBuffer + NUM_START_FRAME_BYTE, busState->endFrame, NUM_END_FRAME_BYTE);
  }

  rewind(busState->videoFile);
  return 0;
}

int main(int argc, char **argv)
{
  const char *busFilePaths[NUM_SPI_BUS];
  const char *defaultPaths[NUM_SPI_BUS] = {
      "videoFile_bus0.txt",
      "videoFile_bus1.txt",
      "videoFile_bus2.txt",
      "videoFile_bus3.txt",
  };
  for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
  {
    busFilePaths[busIndex] = (argc > busIndex + 1) ? argv[busIndex + 1] : defaultPaths[busIndex];
  }

  int fpsArgIndex = NUM_SPI_BUS + 1;
  int targetFps = (argc > fpsArgIndex) ? atoi(argv[fpsArgIndex]) : 30;
  if (targetFps < 1)
  {
    targetFps = 30;
  }

  /* Optional flags after fps: --black-once and --brightness N (any order) */
  int blackOnce = 0;
  for (int argIndex = fpsArgIndex + 1; argIndex < argc; argIndex++)
  {
    if (strcmp(argv[argIndex], "--black-once") == 0)
    {
      blackOnce = 1;
    }
    else if (strcmp(argv[argIndex], "--brightness") == 0 && argIndex + 1 < argc)
    {
      playbackBrightness = atoi(argv[++argIndex]);
    }
  }
  if (playbackBrightness < 1)
    playbackBrightness = 1;
  if (playbackBrightness > 31)
    playbackBrightness = 31;
  long frameDurationUs = 1000000L / targetFps;

  BusState busStates[NUM_SPI_BUS];
  struct timespec frameStart;
  struct timespec frameEnd;

  signal(SIGINT, handleSignal);
  signal(SIGTERM, handleSignal);
  signal(SIGUSR1, handleSignal);

  fprintf(stdout, "Target FPS: %d\n", targetFps);
  fprintf(stdout, "Playback brightness: %d/31\n", playbackBrightness);

  for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
  {
    if (openBusFile(&busStates[busIndex], busFilePaths[busIndex]) != 0)
      return 1;
  }

  spiSetup();

  if (blackOnce)
  {
    for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
    {
      buildBlackFrame(&busStates[busIndex]);
    }
    sendBuffers(busStates);
    keepRunning = 0;
  }

  while (keepRunning)
  {
    clock_gettime(CLOCK_MONOTONIC, &frameStart);

    int frameDecodeFailed = 0;
    for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
    {
      if (busStates[busIndex].ledCount == 0)
        continue;

      ssize_t frameLen = readNextVideoFrame(&busStates[busIndex]);
      (void)frameLen;
      if (decodeFrameLineToBuffer(busStates[busIndex].lineBuf, &busStates[busIndex]) != 0)
      {
        fprintf(stderr, "Bad frame data on bus %d, skipping\n", busIndex);
        frameDecodeFailed = 1;
        break;
      }
    }
    if (frameDecodeFailed)
      continue;

    sendBuffers(busStates);

    clock_gettime(CLOCK_MONOTONIC, &frameEnd);
    long elapsedUs = timeDiffMicroseconds(frameStart, frameEnd);

    long sleepUs = frameDurationUs - elapsedUs;
    if (sleepUs > 0)
    {
      struct timespec sleepTime;
      sleepTime.tv_sec = sleepUs / 1000000L;
      sleepTime.tv_nsec = (sleepUs % 1000000L) * 1000L;
      nanosleep(&sleepTime, NULL);
    }

    clock_gettime(CLOCK_MONOTONIC, &frameEnd);
    long loopUs = timeDiffMicroseconds(frameStart, frameEnd);

    if (loopUs > 0)
    {
      int actualFps = (int)(1000000.0 / (double)loopUs);
      fprintf(stdout, "FPS actual=%d target=%d\n", actualFps, targetFps);
    }
  }

  if (!blackOnce)
  {
    for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
    {
      buildBlackFrame(&busStates[busIndex]);
    }
    sendBuffers(busStates);
  }

  for (int busIndex = 0; busIndex < NUM_SPI_BUS; busIndex++)
  {
    free(busStates[busIndex].lineBuf);
    free(busStates[busIndex].spiBuffer);
    if (busStates[busIndex].videoFile)
      fclose(busStates[busIndex].videoFile);
    close(spiFd[busIndex]);
  }

  return 0;
}
