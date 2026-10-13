# Digivue

网站开发 + 运维方向的 C/C++ 项目。

> 📌 骨架由 `cczcly` 搭建中，细节待补充。

---

## 技术栈

| 项 | 选型 |
|---|---|
| 语言 | C / C++ |
| 构建 | （待定，建议 CMake）|
| 编译器 | （待定：MSVC / GCC / Clang）|
| 标准 | （待定，建议 C++17 或 C++20）|

## 快速开始

```bash
# 克隆
git clone https://github.com/Excapesx/Digivue.git
cd Digivue

# 构建（示例：CMake）
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release

# 运行
（待补充）
```

## 目录结构

```
Digivue/
├── README.md
├── .gitignore
├── src/            # 源码（待建）
├── include/        # 头文件（待建）
├── tests/          # 测试（待建）
├── deploy/         # 运维脚本 / 配置模板（待建）
└── docs/           # 文档（待建）
```

---

# 协作方式（两个人开发）

## 分支策略：**直接在 main 上开发**（本项目约定）

```bash
# 每天开工前
git pull

# 干完活
git add .
git commit -m "feat: 说明改了什么"
git push
```

**⚠️ 虽然不做强制，但仍建议**：
- 改动大或要试错时，**开个分支**（`git checkout -b feature/xxx`），试通了再合回 main
- **推之前先 `git pull`** —— 不然可能被拒（别人推过东西了）

## 遇到 `push` 被拒（non-fast-forward）

```bash
git pull --rebase        # 把你的提交放到对方提交之后
git push
```

## 提交信息（commit message）

```
feat:  新功能
fix:   修 bug
docs:  文档
build: 构建/依赖相关
perf:  性能优化
refactor: 重构（不改行为）
chore: 杂项
```

例：`fix: 修复配置文件解析在空行处崩溃`

## 约定（建议）

- **不要提交**：编译产物、密钥/证书、日志、`.env` —— `.gitignore` 已经挡了大部分 ✓
- **配置文件**：提交 `xxx.conf.example`，真实配置放本地（`.gitignore` 里已忽略 `*.conf.local`）
- **大文件**：>10 MB 的文件别直接提交（Git 历史里删不干净）

---

## 许可证

（待定）
