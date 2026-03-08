import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <header className="app-header">
        <h1>赛博战争模拟器</h1>
        <p>Cyber War Simulator</p>
      </header>
      <main className="app-main">
        <div className="placeholder">
          <h2>🚧 项目初始化中...</h2>
          <p>MVP 开发阶段，敬请期待</p>
          <div className="counter">
            <button onClick={() => setCount((count) => count - 1)}>-</button>
            <span>{count}</span>
            <button onClick={() => setCount((count) => count + 1)}>+</button>
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
