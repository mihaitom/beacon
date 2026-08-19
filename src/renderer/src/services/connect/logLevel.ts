import { fetchConnect } from './http'

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'

interface LogLevelResponse {
  level: LogLevel
  levels: LogLevel[]
}

export async function getLogLevel(): Promise<LogLevelResponse> {
  return fetchConnect<LogLevelResponse>('/log-level')
}

export async function setLogLevel(level: LogLevel): Promise<void> {
  await fetchConnect<{ level: LogLevel }>('/log-level', { method: 'POST', body: { level } })
}
