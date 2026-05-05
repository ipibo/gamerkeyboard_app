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
#define NUM_BYTE_PER_LED 4
#define NUM_START_FRAME_BYTE 4
#define NUM_END_FRAME_BYTE 4
#define SPI_MHZ 9
#define GLOBAL_BYTE 0b11100010
#define FRAME_BITS_PER_LED 32
#define DELIMITER_BITS (NUM_START_FRAME_BYTE * 8)

typedef struct
{
  int bus;
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

static const int SPI_BUSES[NUM_SPI_BUS] = {0, 6};

static volatile sig_atomic_t keepRunning = 1;
static void handleSignal(int signo)
{
  (void)signo;
  keepRunning = 0;
}

static void *sendSpi(void *argsPtr)
{
  SpiThreadArgs *args = (SpiThreadArgs *)argsPtr;

  if (wiringPiSPIxDataRW(args->bus, SPI_CHAN, args->spiData, (int)args->spiDataLen) == -1)
  {
    fprintf(stderr, "SPI bus %d failure: %s\n", args->bus, strerror(errno));
  }

  return NULL;
}

static void spiSetup(int speed)
{
  for (int busIdx = 0; busIdx < NUM_SPI_BUS; busIdx++)
  {
    int bus = SPI_BUSES[busIdx];
    if (wiringPiSPIxSetupMode(bus, SPI_CHAN, speed, SPI_MODE) < 0)
    {
      fprintf(stderr, "Cannot open SPI bus %d: %s\n", bus, strerror(errno));
      exit(EXIT_FAILURE);
    }
  }
}

static void sendBuffers(BusState *bus0State, BusState *bus1State)
{
  pthread_t threads[NUM_SPI_BUS];
  SpiThreadArgs threadArgs[NUM_SPI_BUS];

  threadArgs[0].bus = SPI_BUSES[0];
  threadArgs[0].spiData = bus0State->spiBuffer;
  threadArgs[0].spiDataLen = bus0State->spiBufferBytes;

  threadArgs[1].bus = SPI_BUSES[1];
  threadArgs[1].spiData = bus1State->spiBuffer;
  threadArgs[1].spiDataLen = bus1State->spiBufferBytes;

  for (int busIdx = 0; busIdx < NUM_SPI_BUS; busIdx++)
  {
    pthread_create(&threads[busIdx], NULL, sendSpi, &threadArgs[busIdx]);
  }

  for (int busIdx = 0; busIdx < NUM_SPI_BUS; busIdx++)
  {
    pthread_join(threads[busIdx], NULL);
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
  const char *bus0FilePath = (argc > 1) ? argv[1] : "videoFile_bus0.txt";
  const char *bus1FilePath = (argc > 2) ? argv[2] : "videoFile_bus1.txt";
  int targetFps = (argc > 3) ? atoi(argv[3]) : 30;
  int blackOnce = (argc > 4 && strcmp(argv[4], "--black-once") == 0) ? 1 : 0;
  if (targetFps < 1)
  {
    targetFps = 30;
  }
  long frameDurationUs = 1000000L / targetFps;

  BusState bus0State;
  BusState bus1State;
  struct timespec frameStart;
  struct timespec frameEnd;

  signal(SIGINT, handleSignal);
  signal(SIGTERM, handleSignal);
  signal(SIGUSR1, handleSignal);

  fprintf(stdout, "Target FPS: %d\n", targetFps);

  if (openBusFile(&bus0State, bus0FilePath) != 0)
    return 1;
  if (openBusFile(&bus1State, bus1FilePath) != 0)
    return 1;

  wiringPiSetup();
  spiSetup(SPI_MHZ * 1000000);

  if (blackOnce)
  {
    buildBlackFrame(&bus0State);
    buildBlackFrame(&bus1State);
    sendBuffers(&bus0State, &bus1State);
    keepRunning = 0;
  }

  while (keepRunning)
  {
    clock_gettime(CLOCK_MONOTONIC, &frameStart);

    // Decode next frame for bus 0
    if (bus0State.ledCount > 0)
    {
      ssize_t frameLen = readNextVideoFrame(&bus0State);
      (void)frameLen;
      if (decodeFrameLineToBuffer(bus0State.lineBuf, &bus0State) != 0)
      {
        fprintf(stderr, "Bad frame data on bus 0, skipping\n");
        continue;
      }
    }

    // Decode next frame for bus 1
    if (bus1State.ledCount > 0)
    {
      ssize_t frameLen = readNextVideoFrame(&bus1State);
      (void)frameLen;
      if (decodeFrameLineToBuffer(bus1State.lineBuf, &bus1State) != 0)
      {
        fprintf(stderr, "Bad frame data on bus 1, skipping\n");
        continue;
      }
    }

    sendBuffers(&bus0State, &bus1State);

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
    buildBlackFrame(&bus0State);
    buildBlackFrame(&bus1State);
    sendBuffers(&bus0State, &bus1State);
  }

  free(bus0State.lineBuf);
  free(bus1State.lineBuf);
  free(bus0State.spiBuffer);
  free(bus1State.spiBuffer);
  fclose(bus0State.videoFile);
  fclose(bus1State.videoFile);

  return 0;
}
