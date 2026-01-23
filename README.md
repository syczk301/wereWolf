# 狼人杀网页版（手机优先）

技术栈：Vue 3 + TypeScript + Vite + Pinia + Vue Router；Node.js + Express + Socket.IO + Redis + MongoDB。

## 运行前准备
- MongoDB：默认 `mongodb://127.0.0.1:27017/werewolf`
- Redis：默认 `redis://127.0.0.1:6379`

可选环境变量（不配也能本地跑）：
- `PORT`（默认 `3001`）
- `MONGODB_URI`
- `REDIS_URL`
- `JWT_SECRET`（建议修改）

## 本地开发
```bash
npm install
npm run dev
```

前端地址：`http://localhost:5173`

## 常用脚本
- `npm run dev`：前后端同时启动
- `npm run check`：类型检查
- `npm run lint`：ESLint
- `npm run test`：Vitest（包含后端逻辑测试入口）
