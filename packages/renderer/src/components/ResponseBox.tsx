// 响应展示区：显示最近一次 API 调用的原始 JSON。
// 每个面板共用该组件，通过 testId 区分。
import type { ApiResult } from '../api/client';

interface Props {
  testId: string;
  result: ApiResult | null;
}

// 统一样式：固定高度 + 等宽字体 + 自动换行
const boxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  background: '#f5f5f5',
  border: '1px solid #ddd',
  borderRadius: 4,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  minHeight: 80,
  maxHeight: 240,
  overflow: 'auto',
};

export function ResponseBox({ testId, result }: Props) {
  if (!result) {
    return (
      <div data-testid={testId} style={boxStyle}>
        (暂无响应)
      </div>
    );
  }
  // 把关键信息浓缩成一个对象，方便 Playwright 断言
  const display = {
    ok: result.ok,
    status: result.status,
    error: result.error,
    data: result.data,
  };
  return (
    <div data-testid={testId} style={boxStyle}>
      {JSON.stringify(display, null, 2)}
    </div>
  );
}
