/**
 * LLM API 转发最小接口
 * 
 * 后端仅用于转发请求到大语言模型（LLM）API，
 * 不负责任何业务逻辑计算，且无状态（无存储、无 DB），
 * 所有状态保存在前端 OPFS 中。
 */

import http from 'http'
import https from 'https'
import { URL } from 'url'

interface ForwardRequest {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  payload: Record<string, unknown>
  // 前端将加密好的 key 解密后在请求头或 body 携带过来，后端即用即抛
  apiKey: string
}

export function createApiForwarder() {
  return http.createServer((req, res) => {
    // 跨域处理
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && req.url === '/api/llm/forward') {
      let bodyData = ''
      req.on('data', chunk => {
        bodyData += chunk.toString()
      })
      
      req.on('end', () => {
        try {
          const data: ForwardRequest = JSON.parse(bodyData)
          
          if (!data.apiKey || !data.endpoint || !data.payload) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing required fields: apiKey, endpoint, payload' }))
            return
          }

          forwardToLLM(data, res)

        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }))
        }
      })
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })
}

function forwardToLLM(request: ForwardRequest, clientRes: http.ServerResponse) {
  const targetUrl = new URL(request.endpoint)
  
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${request.apiKey}`,
      // 允许代理其他自定义 headers 如 anthropic-version
    } as Record<string, string>
  }

  // 根据不同 provider 追加特定 Headers
  if (request.provider === 'anthropic') {
    options.headers['x-api-key'] = request.apiKey
    delete options.headers['Authorization']
    // Anthropic API 需要 anthropic-version header
    options.headers['anthropic-version'] = '2023-06-01'
    // Anthropic 使用 anthropic-dangerous-direct-browser-access 来允许浏览器直接访问
    options.headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }

  const protocolClient = targetUrl.protocol === 'https:' ? https : http

  const proxyReq = protocolClient.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode || 500, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*' // 覆盖 CORS
    })
    
    // 流式透传数据到前端
    proxyRes.pipe(clientRes)
  })

  proxyReq.on('error', (err) => {
    console.error('[API Forwarder] Error:', err.message)
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: `Bad Gateway: ${err.message}` }))
    }
  })

  // 发送载荷
  proxyReq.write(JSON.stringify(request.payload))
  proxyReq.end()
}

// 独立启动用于开发测试
const PORT = process.env.PORT || 3001
const server = createApiForwarder()
server.listen(PORT, () => {
  console.log(`[API Forwarder] Listening on http://localhost:${PORT}`)
})