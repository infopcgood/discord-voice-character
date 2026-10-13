// Shared by voice and text: preserve the system prompt and newest user input,
// and keep the prefix stable until the character budget requires a batch trim.
export function conversationMessages(persona, history, user, limit) {
  const system = { role: 'system', content: persona };
  const current = { role: 'user', content: user };
  const requiredChars = persona.length + user.length;
  if (requiredChars > limit) throw new Error('프롬프트와 현재 발화가 HISTORY_MAX_CHARS 한도를 넘습니다.');
  let chars = requiredChars + history.reduce((sum, message) => sum + message.content.length, 0);
  let removed = 0;
  if (chars > limit) {
    const target = Math.max(requiredChars, Math.floor(limit * 0.75));
    while (removed < history.length && (chars > target || history[removed].role === 'assistant')) {
      chars -= history[removed++].content.length;
    }
  }
  return [system, ...history.slice(removed), current];
}
