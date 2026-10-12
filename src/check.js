import { generateDependencyReport } from '@discordjs/voice';
import prism from 'prism-media';
import { requireEnv, model } from './config.js';
import { requireServices } from './services.js';
import { StrataClient } from './llm.js';
console.log(generateDependencyReport());
const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 480 });
decoder.destroy();
const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
encoder.destroy();
console.log('음성 코덱 로딩 성공');
try {
  requireEnv(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']);
  const services = requireServices();
  console.log('필수 설정 입력됨: LLM은 Strata, 음성 인식/합성은 OpenAI');
  if (process.argv.includes('--network')) {
    await new StrataClient({ ...services, model }).check();
    console.log('Strata 모델 연결 성공 (1토큰 점검 요청). OpenAI 음성 인증은 /ai join 및 실제 통화에서 확인하세요.');
  }
}
catch (error) { console.error(error.message); process.exitCode = 1; }

