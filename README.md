# 狼人杀 Werewolf

一个实时多人狼人杀游戏，支持房间创建、角色分配、昼夜阶段、投票、聊天等核心玩法。

## 技术栈

**前端**
- Vue 3 + TypeScript
- Vite
- TailwindCSS
- Socket.IO Client

**后端**
- Node.js + Express
- Socket.IO
- MongoDB (Atlas)
- Redis (可选，支持内存模式)

## 功能特性

- 房间系统：创建/加入房间、房间号搜索、2分钟自动过期
- 角色配置：狼人、村民、预言家、女巫、猎人、守卫、白痴、警长
- 游戏流程：昼夜切换、发言、投票、技能使用
- 聊天系统：公共频道 + 狼人私聊
- 实时同步：基于 Socket.IO 的状态同步

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/werewolf
REDIS_URL=redis://127.0.0.1:6379  # 可选，不配置则使用内存模式
JWT_SECRET=your-secret-key-min-16-chars
PORT=3001
```

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:5173

## 项目结构

```
├── api/                # 后端代码
│   ├── db/             # 数据库连接 (MongoDB, Redis)
│   ├── routes/         # API 路由
│   ├── services/       # 业务逻辑
│   ├── socket.ts       # Socket.IO 事件处理
│   └── server.ts       # 服务器入口
├── src/                # 前端代码
│   ├── components/     # Vue 组件
│   ├── composables/    # 组合式函数
│   ├── pages/          # 页面组件
│   ├── stores/         # Pinia 状态管理
│   └── style.css       # 全局样式
├── shared/             # 前后端共享类型
└── .env                # 环境变量配置
```

## 部署

支持 Vercel 一键部署，已配置 `vercel.json`。

## License

MIT
