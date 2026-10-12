import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, Events, PermissionFlagsBits, ChannelType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { SettingsStore, requireEnv, allowed, root, acceptsGuild, validateSettings } from './config.js';
import { Bridge } from './bridge.js';
import { registerGuild } from './registration.js';
import { requireServices } from './services.js';

requireEnv(['DISCORD_TOKEN']);
const services = requireServices();
const store = new SettingsStore();
const sessions = new Map();
const locks = new Set();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: { parse: [] } });
async function syncGuild(guild) {
  if (!acceptsGuild(guild.id)) return;
  try { await registerGuild(client.rest, client.application.id, guild.id); }
  catch (error) { console.error(`서버 ${guild.id} 명령어 등록 실패: ${error.message}`); }
}
client.once(Events.ClientReady, async bot => {
  for (const guild of bot.guilds.cache.values()) await syncGuild(guild);
  console.log(`${bot.user.tag} 준비 완료. 각 서버의 음성채널에서 /ai join을 사용하세요.`);
});
client.on(Events.GuildCreate, syncGuild);
client.on(Events.GuildDelete, guild => sessions.get(guild.id)?.close());

function sameChannel(member, session) { return member.voice.channelId === session?.channel.id; }
function canControl(member, session) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    (session ? member.id === session.owner && sameChannel(member, session) : allowed.has(member.id));
}
async function reply(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
client.on(Events.InteractionCreate, async interaction => {
  if (!(interaction.isChatInputCommand() && interaction.commandName === 'ai') &&
      !(interaction.isModalSubmit() && interaction.customId === 'ai-persona')) return;
  let locked = false;
  try {
    if (!interaction.inGuild() || !acceptsGuild(interaction.guildId)) throw new Error('허용된 서버에서만 사용할 수 있습니다.');
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (allowed.size && !allowed.has(member.id)) throw new Error('이 봇의 사용 허용 목록에 없는 사용자입니다.');
    const session = sessions.get(interaction.guildId);
    const action = interaction.isModalSubmit() ? 'save-persona' : interaction.options.getSubcommand();
    if (action === 'status') {
      const s = store.get(interaction.guildId);
      await reply(interaction, `연결: ${session ? `<#${session.channel.id}>` : '퇴장 상태'}\n목소리: ${s.voice} · 볼륨: ${Math.round(s.volume * 100)}% · 속도: ${s.speed}\nLLM: Strata / ${s.model}\n음성 인식: OpenAI / ${services.transcriptionModel} · 합성: OpenAI / ${services.ttsModel}\n침묵: ${s.silenceSeconds}초 · 겹침 수신: ${s.overlap ? '켜짐' : '꺼짐'} · 자동 끼어들기: ${s.interrupt ? '켜짐' : '꺼짐'} · 감지 기준: ${s.vadThreshold}\n수신 참여자: ${session?.listeners.size || 0}명\n${session ? (session.busy ? '발화 처리 / AI 응답 중' : '듣기 준비됨') : '/ai join으로 시작하세요.'}\n프롬프트: ${s.persona.length}자 (서버별 저장)`);
      return;
    }
    if (locks.has(interaction.guildId)) throw new Error('설정 또는 연결을 처리 중입니다. 잠시 후 다시 시도하세요.');
    locks.add(interaction.guildId); locked = true;

    if (action === 'join') {
      if (session) throw new Error('이미 음성채널에 연결되어 있습니다. /ai listen enabled:True로 참여하세요.');
      const channel = member.voice.channel;
      if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('먼저 일반 음성채널에 입장하세요. 스테이지 채널은 지원하지 않습니다.');
      const me = interaction.guild.members.me;
      if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new Error('봇에 음성채널 보기·연결·말하기 권한을 주세요.');
      if (!interaction.channel?.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new Error('현재 텍스트 채널에 봇의 보기·메시지 보내기 권한을 주세요.');
      const settings = store.get(interaction.guildId);
      // Public acknowledgement explains what audio is sent before the bot starts listening.
      await interaction.reply({ content: 'AI 음성 대화를 연결합니다. 음성 인식과 합성은 OpenAI를 사용합니다. 인식된 대화문과 캐릭터 프롬프트는 설정된 Strata 서버로 보내 답변을 만들며, AI가 만든 목소리로 응답합니다. 다른 사람은 /ai listen enabled:True로 참여할 수 있습니다.', allowedMentions: { parse: [] } });
      const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
      const notify = text => interaction.channel.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
      const bridge = new Bridge({ connection, channel, owner: member.id, settings, notify,
        onClose: closed => { if (sessions.get(interaction.guildId) === closed) sessions.delete(interaction.guildId); },
      });
      sessions.set(interaction.guildId, bridge);
      try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); await bridge.start(); }
      catch (error) { bridge.close(); throw error; }
      await reply(interaction, `연결 완료: <#${channel.id}>. ${member.displayName}님의 음성은 OpenAI에서 인식하고, 대화문은 Strata에서 처리합니다. 답변 텍스트를 OpenAI로 보내 AI 목소리로 합성합니다.\n말을 마친 뒤 잠시 기다리세요. 다른 참가자: /ai listen enabled:True · 응답 중지: /ai stop · 종료: /ai leave`);
      return;
    }

    if (action === 'listen') {
      if (!session || !sameChannel(member, session)) throw new Error('봇과 같은 음성채널에 있어야 합니다.');
      const enabled = interaction.options.getBoolean('enabled', true);
      session.setListening(member.id, enabled);
      await reply(interaction, enabled ? '내 음성은 OpenAI에서 인식하고 대화문은 Strata로 전송합니다. 답변은 OpenAI가 합성하며 채널 참가자 모두에게 들립니다.' : '이제 내 목소리를 전송하지 않습니다. 이미 보낸 발화는 취소되지 않습니다.');
      return;
    }
    if (action === 'stop') {
      if (!session || !sameChannel(member, session) || (!session.listeners.has(member.id) && !canControl(member, session))) throw new Error('봇과 같은 음성채널의 대화 참가자만 중지할 수 있습니다.');
      session.stop(); await reply(interaction, '현재 응답을 중지했습니다. 잠시 후 다시 말하세요.'); return;
    }
    if (!canControl(member, session)) throw new Error('봇을 부른 사용자(같은 음성채널) 또는 서버 관리자가 설정할 수 있습니다. 먼저 /ai join으로 시작하세요.');
    if (action === 'persona') {
      const persona = store.get(interaction.guildId).persona;
      const input = new TextInputBuilder().setCustomId('text').setLabel('캐릭터 프롬프트 · 저장하면 대화 기억 초기화').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
      if (persona.length <= 4000) input.setValue(persona);
      else input.setPlaceholder('현재 프롬프트가 4000자보다 깁니다. 새 프롬프트를 입력하거나 persona.txt + /ai reload를 사용하세요.');
      await interaction.showModal(new ModalBuilder().setCustomId('ai-persona').setTitle('캐릭터 설정').addComponents(new ActionRowBuilder().addComponents(input)));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (action === 'leave') {
      if (!session) throw new Error('현재 연결된 음성채널이 없습니다.');
      session.close(); await reply(interaction, '음성채널에서 퇴장했습니다.'); return;
    }
    if (action === 'reset') {
      if (!session) throw new Error('먼저 /ai join으로 연결하세요.');
      await session.restart(store.get(interaction.guildId));
      await reply(interaction, '대화 기억을 초기화했습니다. 캐릭터 설정은 유지합니다.'); return;
    }
    const next = store.get(interaction.guildId);
    if (action === 'save-persona') next.persona = interaction.fields.getTextInputValue('text');
    else if (action === 'reload') next.persona = fs.readFileSync(path.join(root, 'persona.txt'), 'utf8');
    else if (action === 'voice') next.voice = interaction.options.getString('name', true);
    else if (action === 'volume') next.volume = interaction.options.getInteger('percent', true) / 100;
    else if (action === 'speed') next.speed = interaction.options.getNumber('value', true);
    else if (action === 'model') next.model = interaction.options.getString('name', true);
    else if (action === 'silence') next.silenceSeconds = interaction.options.getNumber('seconds', true);
    else if (action === 'overlap') next.overlap = interaction.options.getBoolean('enabled', true);
    else if (action === 'interrupt') next.interrupt = interaction.options.getBoolean('enabled', true);
    else if (action === 'sensitivity') next.vadThreshold = interaction.options.getNumber('threshold', true);
    else throw new Error('지원하지 않는 명령입니다.');
    validateSettings(next);
    if (action === 'volume') {
      session?.setVolume(next.volume);
      store.save(interaction.guildId, next);
      await reply(interaction, `볼륨을 ${Math.round(next.volume * 100)}%로 저장했습니다.`);
    } else if (['silence', 'overlap', 'interrupt', 'sensitivity'].includes(action)) {
      if (session) await session.updateListening(next);
      store.save(interaction.guildId, next);
      await reply(interaction, `저장 완료: 침묵 ${next.silenceSeconds}초 · 겹침 수신 ${next.overlap ? '켜짐' : '꺼짐'} · 자동 끼어들기 ${next.interrupt ? '켜짐' : '꺼짐'} · 감지 기준 ${next.vadThreshold}. 대화 기억은 유지됩니다.`);
    } else {
      if (session) await session.restart(next);
      store.save(interaction.guildId, next);
      await reply(interaction, `설정을 저장했습니다. 모델: ${next.model}, 목소리: ${next.voice}, 속도: ${next.speed}.${session ? ' 새 대화로 연결했습니다 (기억 초기화).' : ' 다음 입장부터 적용됩니다. 모델 사용 가능 여부는 입장할 때 확인합니다.'}`);
    }
  } catch (error) {
    console.error(error.message);
    await reply(interaction, `처리 실패: ${error.message}`.slice(0, 1900)).catch(() => {});
  } finally { if (locked) locks.delete(interaction.guildId); }
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const session = sessions.get(before.guild.id);
  if (!session) return;
  if (after.id === client.user?.id && after.channelId !== session.channel.id) {
    session.notify('봇의 음성채널이 변경되어 대화를 종료했습니다. /ai join으로 다시 시작하세요.'); session.close(); return;
  }
  if (before.channelId === session.channel.id && after.channelId !== before.channelId) {
    session.setListening(after.id, false);
    if (!session.channel.members.some(member => !member.user.bot)) session.close();
  }
});
client.on(Events.Error, error => console.error('Discord 연결 오류:', error.message));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const session of sessions.values()) session.close();
  client.destroy(); process.exit(0);
});
client.login(process.env.DISCORD_TOKEN).catch(() => { console.error('로그인 실패: DISCORD_TOKEN과 인터넷 연결을 확인하세요.'); process.exitCode = 1; });

