export const MAX_ACTION_LENGTH = 2000;

export function formatAction(text, actor) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_ACTION_LENGTH) {
    throw new Error(`행동은 1~${MAX_ACTION_LENGTH}자로 입력하세요.`);
  }
  // Keep roleplay actions identifiable in ordinary user messages and history.
  return `[사용자의 행동 · 대사가 아님]\n행동한 사람: ${JSON.stringify(actor)}\n행동: ${text.trim()}\n[/사용자의 행동]`;
}

export function submitAction(member, session, text) {
  if (!session || member.voice.channelId !== session.channel.id) {
    throw new Error('먼저 /ai join으로 연결하고 봇과 같은 음성채널에 입장하세요.');
  }
  // Typing an action does not opt the member into microphone capture.
  session.act(text, member.displayName);
}
