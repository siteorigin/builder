/**
 * Token estimates, shared by the assistant (which keeps a run inside the model's window) and the composer (which says
 * when a message may not fit before it is sent), so both count the same way.
 */

/**
 * About four characters to a token. Chinese, Japanese and Korean characters are often a token each, so they count as
 * one: at a quarter, such text could slip past a window it overflows.
 */
const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/g;
export const estimateTokens = (text: string) => {
  const wide = text.match(WIDE)?.length ?? 0;
  return Math.ceil((text.length - wide) / 4) + wide;
};

/** A window smaller than this gets the small tool set and the focused instructions, whatever the model. */
export const FOCUSED_WINDOW_TOKENS = 64_000;
