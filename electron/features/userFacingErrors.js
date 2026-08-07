const DEFAULT_ERROR_MESSAGE = '操作未完成。请重试；如果仍然失败，请联系维护人员。'

const stripTechnicalPrefixes = value => {
  let text = String(value || '').trim()

  for (let index = 0; index < 3; index += 1) {
    text = text
      .replace(/^Uncaught Exception:\s*/i, '')
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim()
  }

  return text
}

const rawErrorMessage = error => {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message

  return String(error || '')
}

const includesChinese = value => /[\u3400-\u9fff]/u.test(value)

function toUserFacingErrorMessage(error) {
  const message = stripTechnicalPrefixes(rawErrorMessage(error))

  if (!message) return DEFAULT_ERROR_MESSAGE

  const rules = [
    {
      pattern:
        /\bEBUSY\b|resource busy|being used by another process|used by another process|another process.*(?:file|access)|process cannot access.*another process/i,
      text: '文件正在被其他程序使用。请先关闭 Codex 或相关程序，然后重试。'
    },
    {
      pattern: /\bEPERM\b|\bEACCES\b|access (?:is )?denied|permission denied|operation not permitted/i,
      text: '没有权限完成此操作。请先关闭可能占用文件的程序，或以管理员身份重试。'
    },
    {
      pattern: /\bENOSPC\b|no space left|disk (?:is )?full|not enough (?:disk )?space/i,
      text: '磁盘空间不足。请清理一些空间后重试。'
    },
    {
      pattern: /\bEMFILE\b|too many open files/i,
      text: '系统同时打开的文件过多。请关闭部分程序后重试。'
    },
    {
      pattern: /\bENAMETOOLONG\b|file name too long|path too long/i,
      text: '文件名或保存位置过长。请缩短名称，或选择更靠近磁盘根目录的位置。'
    },
    {
      pattern: /\bENOTDIR\b|not a directory/i,
      text: '选择的位置不是文件夹。请重新选择。'
    },
    {
      pattern: /\bEISDIR\b|is a directory/i,
      text: '选择的位置是文件夹。请改选正确的文件。'
    },
    {
      pattern: /\bENOENT\b|no such file or directory|cannot find the (?:file|path)|the system cannot find/i,
      text: '找不到需要的文件或文件夹。它可能已被移动或删除，请刷新后重试。'
    },
    {
      pattern: /invalid ['"]?input\[\d+\]\.id|expected an id that begins with ['"]?ctc/i,
      text: '当前对话的上下文格式与所选模型不兼容。请新建对话，或切回原模型后重试。'
    },
    {
      pattern: /remote compact(?:ion)?|expected exactly one compaction output item/i,
      text: '对话上下文整理失败。请新建对话后继续；原对话记录不会被删除。'
    },
    {
      pattern: /stream must (?:be )?true|stream.*required/i,
      text: '当前接口要求开启流式响应。请重新检测该模型，或检查渠道适配设置。'
    },
    {
      pattern: /no available channel/i,
      text: '当前模型没有可用渠道。请检查在线平台的模型分组和渠道状态，或切换其他模型。'
    },
    {
      pattern:
        /currently experiencing high demand|high demand|selected model is at capacity|model.*(?:at capacity|overloaded)|server_is_overloaded/i,
      text: '当前模型使用人数较多，暂时无法响应。请稍后重试，或切换其他模型。'
    },
    {
      pattern: /\b401\b|unauthori[sz]ed|invalid api[ -]?key|incorrect api[ -]?key|authentication failed/i,
      text: '登录信息或 API Key 无效。请重新登录，或更新 API Key。'
    },
    {
      pattern: /\b403\b|forbidden/i,
      text: '当前账号或 API Key 没有执行此操作的权限。请检查账号和渠道授权。'
    },
    {
      pattern: /\b429\b|rate limit|too many requests|quota exceeded|insufficient_quota/i,
      text: '请求过于频繁或可用额度不足。请稍后重试，或更换可用渠道。'
    },
    {
      pattern: /\b(?:502|503|504)\b|service unavailable|bad gateway|gateway timeout/i,
      text: '上游服务暂时不可用。请稍后重试，或切换其他模型或渠道。'
    },
    {
      pattern: /\b404\b|endpoint not (?:found|supported)|not found.*(?:endpoint|route|url)/i,
      text: '接口或资源不存在。请检查接口地址和渠道配置。'
    },
    {
      pattern: /\b(?:408)\b|\bETIMEDOUT\b|timed out|timeout/i,
      text: '操作等待超时。请检查网络后重试。'
    },
    {
      pattern: /\bECONNREFUSED\b|connection refused/i,
      text: '无法连接到服务。请确认接口地址正确、服务已启动，并检查防火墙设置。'
    },
    {
      pattern: /\bECONNRESET\b|\bEPIPE\b|socket hang up|broken pipe|connection reset/i,
      text: '连接已经中断。请稍后重试；如果仍然失败，请重新启动 Codex。'
    },
    {
      pattern: /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i,
      text: '无法找到服务器地址。请检查网络和接口地址。'
    },
    {
      pattern: /fetch failed|failed to fetch|network ?error/i,
      text: '网络请求失败。请检查网络、接口地址和代理设置。'
    },
    {
      pattern: /certificate|self[- ]signed|unable to verify.*certificate|tls|ssl/i,
      text: '安全连接验证失败。请检查系统时间、证书或代理设置。'
    },
    {
      pattern: /invalid url|failed to parse url|only absolute urls/i,
      text: '接口地址格式不正确。请检查后重试。'
    },
    {
      pattern: /unexpected token|json.*(?:parse|invalid)|not valid json/i,
      text: '服务返回了无法识别的数据。请检查接口兼容性和渠道配置。'
    },
    {
      pattern: /aborterror|operation was aborted|request (?:was )?aborted/i,
      text: '操作已取消。'
    },
    {
      pattern: /compress-archive|expand-archive|archive.*failed|failed.*(?:zip|archive)/i,
      text: '压缩或解压失败。请确认文件未被占用，并检查保存位置是否可用。'
    }
  ]

  const matched = rules.find(rule => rule.pattern.test(message))

  if (matched) return matched.text
  if (includesChinese(message)) return message

  return DEFAULT_ERROR_MESSAGE
}

module.exports = {
  DEFAULT_ERROR_MESSAGE,
  stripTechnicalPrefixes,
  toUserFacingErrorMessage
}
