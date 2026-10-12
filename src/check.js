import { generateDependencyReport } from '@discordjs/voice';
import prism from 'prism-media';
import { requireEnv } from './config.js';
console.log(generateDependencyReport());
const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 480 });
decoder.destroy();
const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
encoder.destroy();
console.log('음성 코덱 로딩 성공');
try { requireEnv(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'OPENAI_API_KEY']); console.log('필수 설정 입력됨 (실제 키 인증은 봇 실행 시 확인)'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
