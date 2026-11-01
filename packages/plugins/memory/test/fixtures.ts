import { Message } from "@opencode/ai/effect"

/** A turn: a user request, an assistant tool call, its result, and a reply. */
export const turn = (number: number, output: string) => [
  Message.user(`request ${number}: please look at file${number}.ts`),
  Message.assistant([
    { type: "text", text: `Checking file${number}.ts` },
    { type: "tool-call", id: `call-${number}`, name: "read", input: { path: `src/file${number}.ts` } },
  ]),
  Message.tool({ id: `call-${number}`, name: "read", result: output, resultType: "text" }),
  Message.assistant(`Done with request ${number}.`),
]

/** A transcript of `count` turns whose tool outputs are `outputSize` characters long. */
export const transcript = (count: number, outputSize: number) => [
  Message.system("You are a helpful agent."),
  ...Array.from({ length: count }, (_, index) =>
    turn(
      index,
      Array.from({ length: Math.ceil(outputSize / 40) }, (_, line) => `line ${line} of output ${index} padding`).join("\n"),
    ),
  ).flat(),
]

/** Every tool call has a result and every result has a call, in the right order. */
export const pairsIntact = (messages: readonly Message[]) => {
  const parts = messages.flatMap((message) => message.content)
  const calls = parts.filter((part) => part.type === "tool-call").map((part) => part.id)
  const results = parts.filter((part) => part.type === "tool-result").map((part) => part.id)
  return calls.length === results.length && calls.every((id, index) => results[index] === id)
}
