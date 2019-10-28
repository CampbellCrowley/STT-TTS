// Copyright 2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (dev@capmbellcrowley.com)
const tts = require('@google-cloud/text-to-speech');
const stt = require('@google-cloud/speech');
const portAudio = require('naudiodon');
const iohook = require('iohook');
const fs = require('fs');

// 0 is only tts cache info (persistent).
// 1 is display audio heartbeat and keyboard triggers.
// 2 is display keyboard keycodes.
// STDOUT writing can cause blocking on some systems.
const DEBUG = 0;

// Audio sample rate for the entire system. Expected to match device settings.
const sampleRate = 44100;
// Audio sample bit format. Must match `startup.wav`.
const sampleFormat = portAudio.SampleFormat16Bit;
// Number of milliseconds long each audio chunk will be.
const deltaSample = 50;
// Total number of milliseconds of audio to buffer.
const historyLength = 2000;

// Path to the Google API credentials file.
process.env.GOOGLE_APPLICATION_CREDENTIALS = './gApiCredentials.json';

// List all devices to log so user knows available options.
const devices = portAudio.getDevices();
function nameFilter(name) {
  return name.replace(/\n/g, '').replace(/\s/g, ' ').replace('%0 ;', ' ');
}
console.log(devices.map((el) => `${el.id}: ${nameFilter(el.name)}`).join('\n'));

// Used if DEBUG == 1, to reduce times to write to stdout when unnecessary.
let lastRoll;
// Timeout after audio input has died to kill all input and restart from scratch
// as an attempt to recover from a failure.
let audioTimeout = null;
// Is a request for STT-TTS queued. If true, after the next chunk of audio is
// received, the whole buffer is sent to the API for processing.
let queued = false;

// The audio input device object reference.
let input;
// Setup the audio input device.
function setupInput() {
  // ID of the audio device to use.
  const iId = (portAudio.getDevices().find(
                   (el) => el.name.indexOf('CABLE Output') > -1) ||
               {id: -1}).id;
  input = new portAudio.AudioIO({
    inOptions: {
      channelCount: 1,
      sampleFormat: sampleFormat,
      sampleRate: sampleRate,
      deviceId: iId,
      highwaterMark:
          Math.ceil(sampleRate * sampleFormat / 8 * (deltaSample / 1000)),
    },
  });
  input.on('end', audioInputDead);
  input.start();
}

// Audio output device object reference.
let output;
// Setup the audio output device.
function setupOutput() {
  // ID of the output device.
  const oId = (portAudio.getDevices().find(
                   (el) => el.name.indexOf('VoiceMeeter VAIO3 Input') > -1) ||
               {id: -1}).id;
  output = new portAudio.AudioIO({
    outOptions: {
      channelCount: 1,
      sampleFormat: sampleFormat,
      sampleRate: sampleRate,
      deviceId: oId,
    },
  });
  output.on('end', () => {
    console.log('Restarting AudioOutput');
    output.quit();
    setupOutput();
  });
  output.start();

  // Play a sound in order to prepend the data with a valid WAV header prior to
  // streaming our data. `startup.wav` must match the format of received audio
  // from the TTS API.
  fs.createReadStream('./startup.wav').on('data', (d) => output.write(d));
}

// Default TTS request settings.
const ttsRequest = {
  input: {text: 'Hello World'},
  voice: {
    languageCode: 'en-US',
    ssmlGender: 'MALE',
    name: 'en-US-Wavenet-D',
  },
  audioConfig: {
    audioEncoding: 'LINEAR16',
    sampleRateHertz: sampleRate,
    pitch: 0,
    speakingRate: 1.0,
  },
};
// Directory to store cached audio files so subsequent requests for the same text
// do not require accessing the API.
const cacheDir = `./cache/${ttsRequest.voice.name}/`;
// Default STT request settings.
const sttRequest = {
  audio: {content: null},
  config: {
    encoding: 'LINEAR16',
    sampleRateHertz: sampleRate,
    languageCode: 'en-US',
  },
};

// Buffer of the last few seconds of audio from the audio input.
const audioBuffer = [];

const ttsClient = new tts.TextToSpeechClient();
const sttClient = new stt.SpeechClient();

/**
 * Convert the given text into speech. Response is played through the output
 * device.
 *
 * @param {string} text The text to convert to speech.
 */
function toSpeech(text) {
  const filename = `${cacheDir}${encodeURIComponent(text)}.wav`;
  if (fs.existsSync(filename)) {
    console.log('CACHE HIT :', text);
    try {
      // WAV header length is 44 bytes. We are appending more audio data to the
      // queue thus we can skip the header after the first audio has been played.
      const rs = fs.createReadStream(filename, {start: 44});
      rs.on('data', (data) => output.write(data));
    } catch(err) {
      console.error(err);
    }
    return;
  }
  console.log('CACHE MISS:', text);

  const req = ttsRequest;
  req.input.text = text;
  ttsClient.synthesizeSpeech(req, (err, res) => {
    if (err) {
      console.error(err);
      return;
    }
    // output.write(res.audioContent);
    fs.writeFile(filename, res.audioContent, (err) => {
      if (err) {
        console.error(err);
        return;
      }
      toSpeech(text);
    });
  });
}

/**
 * Trigger the STT-TTS. If audio input data is available, it will be sent to the
 * STT API, and the response text is then sent to {@link toSpeech}.
 */
function trigger() {
  if (audioBuffer.length * deltaSample < 200) {
    console.error('Failed: No audio');
    return;
  }
  const buf =
      audioBuffer.splice(0).map((el) => el.data.toString('base64')).join('');
  console.log('Triggered STT:', buf.length);
  const req = sttRequest;
  req.audio.content = buf;
  sttClient.recognize(req, (err, res) => {
    if (err) {
      console.error(err);
      return;
    }
    const text = res.results.map((el) => el.alternatives[0].transcript).join('\n');
    if (text.length > 1) toSpeech(text);
  });
}

/**
 * Start the event loops. Starts listening and buffering input audio, and
 * listening to keypresses.
 */
function start() {
  startAudioInput();
  process.stdin.on('data', (data) => {
    const text = data.toString().trim();
    if (text.length > 0) toSpeech(text);
  });

  iohook.on('keydown', (data) => {
    if (DEBUG === 2) {
      console.log(data.keycode);
    }

    // PlayPause press
    // if (!data.altKey && data.keycode === 57378 && !data.shiftKey &&

    // Win + y
    // if (!data.altKey && data.keycode === 21 && !data.shiftKey &&
    //     !data.ctrlKey && data.metaKey) {

    // F2
    if (!data.altKey && data.keycode === 60 && !data.shiftKey && !data.ctrlKey
        && !data.metaKey) {
      queued = true;
    // Win + u
    } else if (!data.altKey && data.keycode === 22 && !data.shiftKey &&
        !data.ctrlKey && data.metaKey) {
      if (audioBuffer.length == 0) return;
      console.log('Loopback');
      audioBuffer.forEach((el) => output.write(el.data));
    }
  });
  iohook.start();
}

/**
 * Ensure the cache directory exists.
 */
function setupCache() {
  fs.mkdir(cacheDir, {recursive: true}, (err) => {
    if (err && err.code !== 'EEXIST') throw err;
  });
}
/**
 * Start listening to input audio.
 */
function startAudioInput() {
  input.on('data', onInputData);
  audioHeartbeat();
}
/**
 * Handle a new audio packet. Pushes it into the buffer, and purges stale
 * packets.
 *
 * @param {Object} data The received audio data.
 */
function onInputData(data) {
  audioHeartbeat();

  const now = Date.now();
  audioBuffer.push({timestamp: now, data: data});

  let index = 0;
  while (audioBuffer.length > index
    && now - audioBuffer[index].timestamp > historyLength) {
    index++;
  }
  if (index > 0) audioBuffer.splice(0, index);

  if (queued) trigger();
  queued = false;

  if (DEBUG !== 1) return;
  const delta = now - (audioBuffer[0] || {timestamp: now}).timestamp;
  process.stdout.write(`\r${delta} `);
  const dots = 30;
  const roll = Math.round((now % historyLength) / historyLength * dots * 2);
  if (lastRoll == roll) return;
  lastRoll = roll;
  for (let i = 0; i < dots; i++) {
    if (roll >= dots) {
      if (i >= roll - dots) {
        process.stdout.write('-');
      } else {
        process.stdout.write('_');
      }
    } else {
      if (i <= roll) {
        process.stdout.write('-');
      } else {
        process.stdout.write('_');
      }
    }
  }
}
/**
 * Consider the audio input to be dead. This will clear the current audio buffer,
 * end all audio input processing, and attempt to restart the inputs.
 */
function audioInputDead() {
  console.log('Restarting AudioInput');
  audioBuffer.splice(0);
  
  clearTimeout(audioTimeout);
  audioTimeout = setTimeout(() => {
    input.quit();
    input.removeListener('data', onInputData);
    input.removeListener('end', audioInputDead);
    setupInput();
    startAudioInput();
  }, 500);
}

/**
 * If the heartbeat is not fired for a period of time, it will consider the
 * audio input to be dead, and call {@link audioInputDead}. This function is no
 * longer used, and doesn't do anything.
 */
function audioHeartbeat() {
  // clearTimeout(audioTimeout);
  // audioTimeout = setTimeout(audioInputDead, 2000);
  return;
}

setupInput();
setupOutput();
setupCache();
start();
