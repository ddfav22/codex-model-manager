const assert = require('assert')

const {
  DEFAULT_ERROR_MESSAGE,
  stripTechnicalPrefixes,
  toUserFacingErrorMessage
} = require('./features/userFacingErrors')

const cases = [
  [
    "Error invoking remote method 'codex:deleteSession': Error: EBUSY: resource busy or locked, unlink 'C:\\test\\session.jsonl'",
    '文件正在被其他程序使用。请先关闭 Codex 或相关程序，然后重试。'
  ],
  ['EPERM: operation not permitted', '没有权限完成此操作。请先关闭可能占用文件的程序，或以管理员身份重试。'],
  ['ENOENT: no such file or directory', '找不到需要的文件或文件夹。它可能已被移动或删除，请刷新后重试。'],
  ['fetch failed', '网络请求失败。请检查网络、接口地址和代理设置。'],
  ['HTTP 401 Unauthorized', '登录信息或 API Key 无效。请重新登录，或更新 API Key。'],
  ['429 rate limit exceeded', '请求过于频繁或可用额度不足。请稍后重试，或更换可用渠道。'],
  ['503 Service Unavailable', '上游服务暂时不可用。请稍后重试，或切换其他模型或渠道。'],
  ['Selected model is at capacity.', '当前模型使用人数较多，暂时无法响应。请稍后重试，或切换其他模型。'],
  ['Currently experiencing high demand.', '当前模型使用人数较多，暂时无法响应。请稍后重试，或切换其他模型。'],
  ['stream must be true', '当前接口要求开启流式响应。请重新检测该模型，或检查渠道适配设置。'],
  [
    "Invalid 'input[7].id': 'fc_123'. Expected an ID that begins with 'ctc'.",
    '当前对话的上下文格式与所选模型不兼容。请新建对话，或切回原模型后重试。'
  ],
  ['Unexpected token < in JSON at position 0', '服务返回了无法识别的数据。请检查接口兼容性和渠道配置。'],
  ['这是已经可以理解的中文提示。', '这是已经可以理解的中文提示。'],
  ['An unknown internal implementation detail with C:\\private\\path', DEFAULT_ERROR_MESSAGE]
]

assert.strictEqual(stripTechnicalPrefixes("Error invoking remote method 'codex:test': Error: EPIPE"), 'EPIPE')

for (const [input, expected] of cases) assert.strictEqual(toUserFacingErrorMessage(input), expected, input)

assert.doesNotMatch(toUserFacingErrorMessage(cases[0][0]), /EBUSY|C:\\/)
assert.doesNotMatch(toUserFacingErrorMessage(cases.at(-1)[0]), /private|internal|C:\\/i)

console.log(`用户可见错误中文转换测试通过（${cases.length} 个案例）。`)
