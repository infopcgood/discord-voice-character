import { StrataClient } from './llm.js';
import { conversationMessages } from './conversation.js';

export const MAX_CHAT_LENGTH = 2000;

export function formatChat(text, actor) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHAT_LENGTH) {
    throw new Error('대사는 1~2000자로 입력하세요.');
  }
  return `[발화자: ${JSON.stringify(actor)}]\n${text.trim()}`;
}

// Preserve every character, including whitespace, without splitting a surrogate pair.
export function splitDiscordText(text) {
  const chunks = [];
  while (text.length) {
    let end = Math.min(text.length, 2000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  return chunks;
}

export function messagePayload(content, visibility = 'public') {
  // Discord's EPHEMERAL flag must also be set explicitly on every follow-up.
  return { content, allowedMentions: { parse: [] }, ...(visibility === 'private' ? { flags: 64 } : {}) };
}

export async function publishCommandInput(interaction, action, text, actor, visibility = 'public') {
  const name = actor.replace(/[\\`*_{}\[\]()<>~|]/g, '\\$&').replace(/[\r\n]/g, ' ');
  const chunks = splitDiscordText(`**${name} · /ai ${action}**\n${text}`);
  await interaction.reply(messagePayload(chunks[0], visibility));
  for (const content of chunks.slice(1)) await interaction.followUp(messagePayload(content, visibility));
}

export function textSessionKey(guildId, channelId, visibility, userId) {
  return `${guildId}:${channelId}:${visibility === 'private' ? `private:${userId}` : 'public'}`;
}

export function closeTextSessions(sessions, guildId, channelId) {
  for (const [key, session] of sessions) {
    if (session.guildId === guildId && (channelId === undefined || session.channelId === channelId)) {
      session.close(); sessions.delete(key);
    }
  }
}

export class TextSession {
  constructor({ guildId, channelId, owner, settings, services, llm }) {
    Object.assign(this, { guildId, channelId, owner, services });
    this.settings = { ...settings };
    this.llm = llm || new StrataClient({ ...services, model: settings.model });
    this.history = []; this.turn = null; this.closed = false; this.lastActivity = Date.now();
  }
  get busy() { return Boolean(this.turn); }
  async respond(input, { publishInput, publishReply }) {
    if (this.closed) throw new Error('텍스트 대화가 종료되었습니다. /ai chat으로 다시 시작하세요.');
    if (this.busy) throw new Error('이 채널의 답변을 생성 중입니다. 잠시 기다리거나 /ai stop으로 중지하세요.');
    const messages = conversationMessages(this.settings.persona, this.history, input, this.services.historyChars);
    const turn = { controller: new AbortController(), cancelled: false };
    this.turn = turn; this.lastActivity = Date.now();
    const timer = setTimeout(() => turn.controller.abort(new Error('텍스트 응답 시간이 초과되었습니다.')), this.services.responseTimeoutMs);
    try {
      // Show the user's full input before committing it to conversation memory.
      await publishInput(); turn.controller.signal.throwIfAborted();
      this.history = messages.slice(1);
      let answer = '';
      for await (const delta of this.llm.stream(messages, turn.controller.signal)) {
        turn.controller.signal.throwIfAborted(); answer += delta;
      }
      turn.controller.signal.throwIfAborted();
      if (!answer.trim()) throw new Error('Strata 답변이 비어 있습니다.');
      let assistant;
      for (const content of splitDiscordText(answer)) {
        turn.controller.signal.throwIfAborted();
        await publishReply(content);
        turn.controller.signal.throwIfAborted();
        // Only text successfully posted to Discord is remembered.
        if (!assistant) { assistant = { role: 'assistant', content: '' }; this.history.push(assistant); }
        assistant.content += content;
      }
    } catch (error) {
      if (!turn.cancelled) throw error;
    } finally {
      clearTimeout(timer); this.lastActivity = Date.now();
      if (this.turn === turn) this.turn = null;
    }
  }
  stop() {
    if (!this.turn) return;
    this.turn.cancelled = true; this.turn.controller.abort();
  }
  close() { this.closed = true; this.stop(); this.history = []; }
}
