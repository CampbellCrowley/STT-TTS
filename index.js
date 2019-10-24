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
const DEBUG = 1;

const sampleRate = 44100;
const sampleFormat = portAudio.SampleFormat16Bit;
const deltaSample = 50;
const historyLength = 2000;

process.env.GOOGLE_APPLICATION_CREDENTIALS = './gApiCredentials.json';
const devices = portAudio.getDevices();
function nameFilter(name) {
  return name.replace(/\n/g, '').replace(/\s/g, ' ').replace('%0 ;', ' ');
}
console.log(devices.map((el) => `${el.id}: ${nameFilter(el.name)}`).join('\n'));

let lastRoll;
let audioTimeout = null;
let queued = false;

let input;
function setupInput() {
  const iId = portAudio.getDevices()
                .find((el) => el.name.indexOf('CABLE Output') > -1)
                .id;
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

let output;
function setupOutput() {
  const oId = portAudio.getDevices()
                .find((el) => el.name.indexOf('VoiceMeeter VAIO3 Input') > -1)
                .id;
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

  fs.createReadStream('./startup.wav').on('data', (d) => output.write(d));
}

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
const cacheDir = `./cache/${ttsRequest.voice.name}/`;
const sttRequest = {
  audio: {content: null},
  config: {
    encoding: 'LINEAR16',
    sampleRateHertz: sampleRate,
    languageCode: 'en-US',
  },
};

const audioBuffer = [];

const ttsClient = new tts.TextToSpeechClient();
const sttClient = new stt.SpeechClient();

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
    // console.log(data.keycode);

    // PlayPause press
    // if (!data.altKey && data.keycode === 57378 && !data.shiftKey &&

    // Win + y
    // if (!data.altKey && data.keycode === 21 && !data.shiftKey &&
    //     !data.ctrlKey && data.metaKey) {

    if (!data.altKey && data.keycode === 60 && !data.shiftKey && !data.ctrlKey
        && !data.metaKey) {
      queued = true;
    } else if (!data.altKey && data.keycode === 22 && !data.shiftKey &&
        !data.ctrlKey && data.metaKey) {
      if (audioBuffer.length == 0) return;
      console.log('Loopback');
      audioBuffer.forEach((el) => output.write(el.data));
    }
  });
  iohook.start();
}

function setupCache() {
  fs.mkdir(cacheDir, {recursive: true}, (err) => {
    if (err && err.code !== 'EEXIST') throw err;
  });
}
function startAudioInput() {
  input.on('data', onInputData);
  audioHeartbeat();
}
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

function audioHeartbeat() {
  return;
  // clearTimeout(audioTimeout);
  // audioTimeout = setTimeout(audioInputDead, 2000);
}

setupInput();
setupOutput();
setupCache();
start();
