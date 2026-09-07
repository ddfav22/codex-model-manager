const assert = require('assert')
const fs = require('fs')
const path = require('path')

const sourceRoot = path.join(__dirname, '..', 'src', 'views', 'model-manager')
const read = relativePath => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8')

const modelManager = read('ModelManager.tsx')
const conversationRows = read(path.join('components', 'ConversationRows.tsx'))
const transferDialog = read(path.join('components', 'ConversationTransferDialog.tsx'))

// Keep the user-visible safety contract close to the UI implementation.  This
// is intentionally a source-level test because the repository does not ship a
// browser component test runner; packaged-ui exercises the rendered flow.
assert.match(modelManager, /removeProjectFolders\s*=/)
assert.match(modelManager, /deleteFilteredConversationData\('records'\)/)
assert.match(modelManager, /deleteFilteredConversationData\('records-and-project-folders'\)/)
assert.match(modelManager, /不会删除磁盘上的项目文件夹/)
assert.match(modelManager, /清理项目文件夹/)
assert.match(modelManager, /refreshAfterConversationMutation\(result\.status\)/)
assert.match(modelManager, /result\.indexDelete\?\.ok === false/)
assert.match(modelManager, /globalStatePrune\?\.changed/)
assert.match(modelManager, /position:\s*'fixed'/)
assert.match(modelManager, /aria-label='当前筛选结果统计'/)
assert.doesNotMatch(modelManager, /在线插件商店/)
assert.doesNotMatch(modelManager, /installOnlineSkill/)

assert.match(conversationRows, /aria-label='永久删除对话'/)
assert.match(conversationRows, /aria-label='修改对话名称'/)
assert.match(modelManager, /renameSession\(editingSession\.path, title\)/)
assert.match(modelManager, /将同时修改本地 JSONL 元数据/)
assert.match(conversationRows, /aria-label='移除项目记录'/)
assert.match(conversationRows, /aria-label='恢复未完成任务'/)
assert.match(conversationRows, /仅移除记录/)
assert.match(transferDialog, /重复导入前请确认目标文件或项目路径/)
assert.match(transferDialog, /不会删除或移动原项目文件夹/)

console.log('model-manager UI safety and layout invariants passed')
