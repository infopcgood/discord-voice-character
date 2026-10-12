import { SlashCommandBuilder } from 'discord.js';
import { voices } from './config.js';

const command = new SlashCommandBuilder().setName('ai').setDescription('음성 캐릭터와 대화합니다').setDMPermission(false);
for (const [name, description] of Object.entries({
  join: '내 음성채널에 입장합니다 (내 음성을 OpenAI로 전송)',
  leave: '음성채널에서 퇴장합니다',
  persona: '캐릭터 프롬프트 설정 창을 엽니다',
  reload: 'persona.txt의 프롬프트를 다시 읽습니다',
  stop: 'AI의 현재 응답을 중지합니다',
  reset: '대화 기억을 지우고 다시 시작합니다',
  status: '현재 설정과 연결 상태를 확인합니다',
})) command.addSubcommand(s => s.setName(name).setDescription(description));
command.addSubcommand(s => s.setName('voice').setDescription('목소리를 선택합니다 (대화 기억 초기화)')
  .addStringOption(o => o.setName('name').setDescription('목소리').setRequired(true).addChoices(...voices.map(name => ({ name, value: name })))));
command.addSubcommand(s => s.setName('volume').setDescription('AI 목소리의 볼륨을 바꿉니다')
  .addIntegerOption(o => o.setName('percent').setDescription('0~200%, 기본 80%').setRequired(true).setMinValue(0).setMaxValue(200)));
command.addSubcommand(s => s.setName('speed').setDescription('AI의 말하기 속도를 바꿉니다 (대화 기억 초기화)')
  .addNumberOption(o => o.setName('value').setDescription('0.25~1.5, 기본 1').setRequired(true).setMinValue(0.25).setMaxValue(1.5)));
command.addSubcommand(s => s.setName('listen').setDescription('내 목소리의 AI 전송을 켜거나 끕니다')
  .addBooleanOption(o => o.setName('enabled').setDescription('켜기: 내 목소리를 OpenAI로 전송').setRequired(true)));
command.addSubcommand(s => s.setName('silence').setDescription('말을 마친 뒤 응답까지 기다리는 침묵 시간')
  .addNumberOption(o => o.setName('seconds').setDescription('0.2~5초, 기본 0.85초').setRequired(true).setMinValue(0.2).setMaxValue(5)));
command.addSubcommand(s => s.setName('overlap').setDescription('여러 사람이 겹쳐 말할 때 함께 듣기')
  .addBooleanOption(o => o.setName('enabled').setDescription('켜기: 동시 발화 혼합 / 끄기: 먼저 말한 사람 우선').setRequired(true)));
command.addSubcommand(s => s.setName('interrupt').setDescription('AI가 말하는 중 사용자 발화로 자동 중지')
  .addBooleanOption(o => o.setName('enabled').setDescription('자동 끼어들기, 기본 켜기').setRequired(true)));
command.addSubcommand(s => s.setName('model').setDescription('이 서버의 Realtime 음성 모델 변경 (대화 기억 초기화)')
  .addStringOption(o => o.setName('name').setDescription('계정에서 사용 가능한 Realtime 음성 모델 ID').setRequired(true).setMaxLength(120)));
command.addSubcommand(s => s.setName('sensitivity').setDescription('음성 감지 기준 조절 (높을수록 작은 소리 무시)')
  .addNumberOption(o => o.setName('threshold').setDescription('0.1~0.9, 기본 0.5').setRequired(true).setMinValue(0.1).setMaxValue(0.9)));
export const commands = [command.toJSON()];
