import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

import type { RelayProvider } from '@/types/codex-manager'

import {
  cleanErrorMessage,
  modelCapability,
  modelReady,
  modelSummary,
  modelTest,
  providerModels,
  providerSource
} from '../modelManagerCore'
import { channelGridColumns, channelGridMinWidth, rowSurfaceSx } from './ManagerLayout'

export const ChannelRow = ({
  provider,
  busy,
  testing,
  selectingKey,
  refreshing,
  activating,
  pendingApply,
  selectedKeyId,
  selectedModel,
  onSelectedModelChange,
  onKeyChange,
  onRefresh,
  onTest,
  onApply,
  onEdit,
  onRemove
}: {
  provider: RelayProvider
  busy: boolean
  testing: boolean
  selectingKey: boolean
  refreshing: boolean
  activating: boolean
  pendingApply: boolean
  selectedKeyId: string
  selectedModel: string
  onSelectedModelChange: (id: string, model: string) => void
  onKeyChange: (id: string, tokenId: string | number) => void
  onRefresh: (id: string) => void
  onTest: (id: string) => void
  onApply: (id: string, model: string) => void
  onEdit: (provider: RelayProvider) => void
  onRemove: (id: string) => void
}) => {
  const models = providerModels(provider)
  const firstSupportedModel = models.find(model => modelCapability(provider, model)?.available !== false) || ''
  const activeModel = selectedModel || provider.model || firstSupportedModel || models[0] || ''
  const selectedTest = activeModel ? modelTest(provider, activeModel) : null
  const selectedCapability = activeModel ? modelCapability(provider, activeModel) : null
  const adapterUnavailable = provider.managed && selectedCapability?.available === false
  const needsTest = provider.managed && !adapterUnavailable && !modelReady(provider, activeModel)
  const isCurrentSelection = provider.active && provider.model === activeModel
  const onlineKeys = provider.newApi?.keys || []
  const selectedTokenId = selectedKeyId || String(provider.newApi?.selectedTokenId ?? provider.newApi?.tokenId ?? '')

  return (
    <Box
      sx={{
        ...rowSurfaceSx,
        display: 'grid',
        gridTemplateColumns: channelGridColumns,
        gap: 1.5,
        alignItems: 'center',
        minInlineSize: channelGridMinWidth,
        mx: 2,
        my: 1.5,
        px: 2.5,
        py: 2.5,
        border: 1,
        borderColor: provider.active ? 'primary.main' : 'divider',
        borderRadius: 2,
        bgcolor: provider.active ? 'primary.lighterOpacity' : 'background.paper',
        boxShadow: provider.active ? '0 8px 24px rgba(115, 103, 240, 0.12)' : '0 2px 10px rgba(47, 43, 61, 0.05)'
      }}
    >
      <Stack spacing={0.5} sx={{ minInlineSize: 0 }}>
        <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
          <Typography variant='body2' fontWeight={600} noWrap>
            {provider.name}
          </Typography>
          {provider.active && <Chip color='success' size='small' variant='tonal' label='使用中' />}
        </Stack>
        <Typography variant='caption' color='text.secondary' noWrap>
          {providerSource(provider)}
        </Typography>
      </Stack>
      <Tooltip title={provider.baseUrl || '原生默认渠道'}>
        <Typography variant='body2' color='text.secondary' noWrap sx={{ minInlineSize: 0 }}>
          {provider.baseUrl || '原生默认渠道'}
        </Typography>
      </Tooltip>
      {provider.keySource === 'newapi' ? (
        <TextField
          select
          size='small'
          label='API Key（可随时更换）'
          value={selectedTokenId}
          disabled={refreshing || onlineKeys.length < 2}
          onChange={event => onKeyChange(provider.id, event.target.value)}
          inputProps={{ 'aria-label': `选择 ${provider.name} 的 API Key` }}
          helperText={
            selectingKey
              ? '正在读取模型；仍可继续选择其他 Key，以最后一次选择为准'
              : pendingApply
                ? 'Key 已更换，测试后应用；仍可再次更换'
                : onlineKeys.length < 2
                  ? '当前平台只有一个可用 Key'
                  : '随时可更换 Key'
          }
        >
          {onlineKeys.map(key => (
            <MenuItem key={String(key.id ?? key.name)} value={String(key.id ?? key.name)}>
              {key.name} · {key.keyMask || '未读取'}
            </MenuItem>
          ))}
        </TextField>
      ) : (
        <Typography variant='body2' color='text.secondary' noWrap>
          {provider.apiKeyMask || (provider.managed ? '未保存' : 'Codex 登录')}
        </Typography>
      )}
      <Stack spacing={1} sx={{ minInlineSize: 0 }}>
        {models.length > 1 ? (
          <TextField
            select
            size='small'
            value={activeModel}
            disabled={busy || selectingKey}
            onChange={event => onSelectedModelChange(provider.id, event.target.value)}
            inputProps={{ 'aria-label': '选择启用模型' }}
          >
            {models.map(model => (
              <MenuItem key={model} value={model} disabled={modelCapability(provider, model)?.available === false}>
                {model}
                {modelCapability(provider, model)?.available === false ? '（适配未完成，暂不可用）' : ''}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Typography variant='body2' noWrap>
            {modelSummary(provider)}
          </Typography>
        )}
        {models.length > 1 && (
          <Typography variant='caption' color='text.secondary' noWrap>
            {selectedTest?.ok
              ? `${selectedTest.actualModel ? `实际：${selectedTest.actualModel} · ` : ''}${selectedTest.latencyMs} ms · ${
                  selectedTest.toolTransport === 'prompt-emulated' ? '兼容工具链' : '原生工具链'
                }`
              : adapterUnavailable
                ? selectedCapability?.reason
                  ? cleanErrorMessage(selectedCapability.reason)
                  : '适配未完成，暂不可用'
                : selectedTest
                  ? '未通过，请重测'
                  : '未测试'}
          </Typography>
        )}
      </Stack>
      <Stack direction='row' spacing={0.75} alignItems='center' flexWrap='wrap' useFlexGap>
        {activating ? (
          <Chip
            color='primary'
            size='small'
            variant='tonal'
            label='配置并启动中'
            icon={<CircularProgress size={12} color='inherit' />}
          />
        ) : pendingApply ? (
          <Chip color='info' size='small' variant='tonal' label='待应用' />
        ) : testing ? (
          <Chip
            color='primary'
            size='small'
            variant='tonal'
            label='测试中'
            icon={<CircularProgress size={12} color='inherit' />}
          />
        ) : provider.managed ? (
          <Chip
            color={
              adapterUnavailable
                ? 'default'
                : selectedTest?.agentToolOk && selectedTest?.streamOk
                  ? 'success'
                  : 'warning'
            }
            size='small'
            variant='tonal'
            label={
              adapterUnavailable
                ? '适配未完成，暂不可用'
                : selectedTest?.agentToolOk && selectedTest?.streamOk
                  ? '聊天、流式与工具续答通过'
                  : selectedTest
                    ? '完整检测未通过'
                    : '完整检测待测'
            }
          />
        ) : (
          <Chip size='small' variant='outlined' label='只读' />
        )}
        {provider.testStatus?.latencyMs ? (
          <Typography variant='caption' color='text.secondary' noWrap>
            {provider.testStatus.actualModel ? `实际：${provider.testStatus.actualModel} · ` : ''}
            {provider.testStatus.latencyMs} ms
          </Typography>
        ) : null}
      </Stack>
      <Stack direction='row' spacing={1} justifyContent='flex-end' alignItems='center' flexWrap='wrap' useFlexGap>
        {provider.managed && Boolean(provider.baseUrl) && (
          <Button
            size='small'
            variant='outlined'
            color='primary'
            sx={{ minInlineSize: provider.keySource === 'newapi' ? 112 : 96, px: 1.25, fontWeight: 600 }}
            disabled={busy || testing || selectingKey || refreshing}
            aria-label={
              provider.keySource === 'newapi'
                ? `刷新 ${provider.name} 的 Key 和模型`
                : `刷新 ${provider.name} 当前 Key 的模型`
            }
            startIcon={refreshing ? <CircularProgress size={13} color='inherit' /> : <i className='ri-refresh-line' />}
            onClick={() => onRefresh(provider.id)}
          >
            {refreshing ? '刷新中' : provider.keySource === 'newapi' ? '刷新 Key/模型' : '刷新模型'}
          </Button>
        )}
        {Boolean(provider.baseUrl) && (
          <Button
            size='small'
            variant='outlined'
            sx={{ minInlineSize: 44, px: 1.25 }}
            disabled={busy || testing || selectingKey}
            startIcon={testing ? <CircularProgress size={12} /> : undefined}
            onClick={() => onTest(provider.id)}
          >
            检测全部
          </Button>
        )}
        <Tooltip
          title={
            adapterUnavailable
              ? selectedCapability?.reason
                ? cleanErrorMessage(selectedCapability.reason)
                : '适配未完成，暂不可用'
              : needsTest
                ? '聊天、流式响应和工具续答检测全部通过后才可启用'
                : ''
          }
        >
          <span>
            <Button
              size='small'
              variant='contained'
              sx={{ minInlineSize: 78, px: 1.25 }}
              disabled={busy || selectingKey || needsTest || adapterUnavailable}
              startIcon={activating ? <CircularProgress size={12} color='inherit' /> : undefined}
              onClick={() => onApply(provider.id, activeModel)}
            >
              {activating ? '启动中' : pendingApply ? '应用并重启' : isCurrentSelection ? '同步并重启' : '启用并重启'}
            </Button>
          </span>
        </Tooltip>
        {provider.managed && (
          <Tooltip title='编辑'>
            <IconButton size='small' disabled={busy || selectingKey} onClick={() => onEdit(provider)}>
              <i className='ri-edit-2-line' />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={provider.managed ? '删除' : '只读'}>
          <span>
            <IconButton
              size='small'
              color='error'
              disabled={busy || selectingKey || !provider.managed}
              onClick={() => onRemove(provider.id)}
            >
              <i className='ri-delete-bin-6-line' />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  )
}
