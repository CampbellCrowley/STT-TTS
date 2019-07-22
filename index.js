// Copyright 2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (dev@capmbellcrowley.com)
const tts = require('@google-cloud/text-to-speech');
const stt = require('@google-cloud/speech');
const portAudio = require('naudiodon');
const Readable = require('stream').Readable;
const fs = require('fs');
const iohook = require('iohook');

process.env.GOOGLE_APPLICATION_CREDENTIALS = './gApiCredentials.json';
// Audio device ID.
const id = -1;

const sampleRate = 44100;
const sampleFormat = portAudio.SampleFormat16Bit;
const deltaSample = 100;
const historyLength = 3000;

const devices = portAudio.getDevices();
console.log(devices);
const input = new portAudio.AudioIO({
  inOptions: {
    channelCount: 1,
    sampleFormat: sampleFormat,
    sampleRate: sampleRate,
    deviceId: id,
    highwaterMark:
        Math.ceil(sampleRate * sampleFormat / 8 * (deltaSample / 1000)),
  },
});
const output = new portAudio.AudioIO({
  outOptions: {
    channelCount: 1,
    sampleFormat: sampleFormat,
    sampleRate: sampleRate,
    deviceId: -1,
  },
});

const ttsRequest = {
  input: {text: 'Hello World'},
  voice: {languageCode: 'en-US', ssmlGender: 'MALE'},
  audioConfig: {
    audioEncoding: 'LINEAR16',
    sampleRateHertz: sampleRate,
    pitch: 2,
    speakingRate: 1.5,
  },
};
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
  const req = ttsRequest;
  req.input.text = text;
  ttsClient.synthesizeSpeech(req, (err, res) => {
    if (err) {
      console.error(err);
      return;
    }
    output.write(res.audioContent);
  });
}

function trigger() {
  if (audioBuffer.length * deltaSample < 200) {
    console.error('Failed: No audio');
    return;
  }
  const buf =
      audioBuffer.splice(0).map((el) => el.data.toString('base64')).join('');
  const req = sttRequest;
  req.audio.content = buf;
  sttClient.recognize(req, (err, res) => {
    if (err) {
      console.error(err);
      return;
    }
    const text = res.results.map((el) => el.alternatives[0].transcript).join('\n');
    console.log(text);
    if (text.length > 1) toSpeech(text);
  });
}

function start() {
  input.on('data', (data) => {
    const now = Date.now();
    audioBuffer.push({timestamp: now, data: data});
    let index = 0;
    while (now - audioBuffer[index].timestamp > historyLength) index++;
    if (index > 0) audioBuffer.splice(0, index);
  });
  process.stdin.on('data', (data) => {
    const text = data.toString().trim();
    if (text.length > 0) toSpeech(text);
  });

  fs.readFile('./startup.wav', (err, data) => {
    if (err) {
      console.error(err);
      return;
    }
    output.write(data);
  });
  input.start();
  output.start();

  iohook.on('keydown', (data) => {
    if (data.altKey && data.keycode === 78 && !data.shiftKey && !data.ctrlKey &&
        !data.metaKey) {
      trigger();
    }
  });
  iohook.start();
}

start();
