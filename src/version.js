// 运行时版本号只有一个来源：清单 yh-app.json。/health、页面右上角、关于页、MCP 都取这里；VERSION、package.json 由测试校验一致
import { readFileSync } from 'node:fs'

export const VERSION = JSON.parse(readFileSync(new URL('../yh-app.json', import.meta.url), 'utf8')).version
