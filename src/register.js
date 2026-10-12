import { REST } from 'discord.js';
import { requireEnv, guildIds } from './config.js';
import { registerGuild } from './registration.js';
try {
  requireEnv(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const id of guildIds) await registerGuild(rest, process.env.DISCORD_CLIENT_ID, id);
  console.log(guildIds.size ? `${guildIds.size}개 서버에 명령어를 등록했습니다.` : '봇을 시작하면 참여 중인 모든 서버에 명령어를 자동 등록합니다.');
} catch (error) { console.error('명령어 등록 실패:', error.message); process.exitCode = 1; }
