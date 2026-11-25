const test=require('node:test');const assert=require('node:assert/strict');const {validateAudio}=require('../asr-service');
test('local ASR accepts only bounded mono PCM with a valid sample rate',()=>{
 const pcm=Buffer.alloc(32000).toString('base64');const result=validateAudio({pcm,sampleRate:16000,terms:'统计口径'});assert.equal(result.sampleRate,16000);assert.equal(result.terms,'统计口径');
 for(const input of [{pcm:'bad!',sampleRate:16000},{pcm,sampleRate:1},{pcm:Buffer.alloc(3).toString('base64'),sampleRate:16000},{pcm:'',sampleRate:16000},{pcm:Buffer.alloc(32000*121).toString('base64'),sampleRate:16000}])assert.throws(()=>validateAudio(input));
});
