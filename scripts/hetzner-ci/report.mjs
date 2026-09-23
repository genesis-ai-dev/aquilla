import { renderReport, publishReport } from "./smart-test-comment.mjs"
let input = ""
for await (const chunk of process.stdin) input += chunk
const args = JSON.parse(input)
const body = renderReport(args)
console.log(await publishReport({ ...args, body }))
