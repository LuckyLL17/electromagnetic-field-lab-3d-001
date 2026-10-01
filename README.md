# ElectroMag Lab · 3D

基于 React、Vite、TypeScript、Three.js 与 React Three Fiber 的专业 3D 可视化实验平台。

## 启动

```bash
npm install
npm run dev
```

开发端口：`5176`。

## 实验会话（Experiment Session）

侧栏「实验会话 · 检查点时间轴」面板支持把一次实验的关键状态固化为**不可变检查点**并进行时间轴回放。

- **检查点内容**：场型、激励强度、场矢量开关，以及相机位置与 OrbitControls 朝向目标点。所有数据都是纯 JSON 值（深拷贝 + `Object.freeze` 深冻结），不持有 Three.js 活动引用。
- **录制**：调好控制台与视角后点击「记录检查点」，时间戳为相对录制起点的毫秒数（非递减）。
- **时间轴回放**：播放 / 暂停 / 继续 / 拖动进度或检查点跳转 / 取消 / 结束后重新回放。回放期间（含结束态，直至显式恢复）控制台与 OrbitControls 自动锁定。
- **原子同步**：控制区与三维场景共享同一份 `LabState`；回放应用检查点是单次 React 提交，相机经 `cameraNonce + useLayoutEffect` 在绘制前写入，二者不可能出现半同步。
- **取消语义**：播放开始时捕获实时基线快照（含真实相机），取消或中断后原子恢复基线，半程状态不会污染当前实验。
- **JSON 导入导出**：导出为带版本信封的 JSON 文件；导入时**先完整解析校验再提交**——坏 JSON、未知 `format`、未知版本、字段缺失/类型错误、越界强度、递减时间戳一律整文件拒绝，当前实验与会话保持不变；多余字段与缺失的顶层元数据则兼容忽略/补全。
- **资源纪律**：导出产生的 Object URL 统一登记、下载调度后立即回收，面板卸载兜底回收；回放使用单条 `requestAnimationFrame`，暂停/取消/结束/卸载都会同步取消，不残留定时器。

### 核心模块

| 文件 | 职责 |
| --- | --- |
| `src/session/types.ts` | 领域模型与 JSON 信封格式（`format` / `version: 1`） |
| `src/session/checkpoints.ts` | 检查点创建/追加（不可变）、序列化、严格解析、时间轴下标 |
| `src/session/player.ts` | 回放状态机内核（可注入 `TimelineClock`，不依赖 DOM） |
| `src/session/useTimelinePlayer.ts` | React 生命周期托管与卸载清理 |
| `src/session/io.ts` | JSON 文件读写、Object URL 生命周期、大小上限 |
| `src/SessionPanel.tsx` | 录制/时间轴/传输/导入导出 UI 与失败提示 |
| `src/EMScene.tsx` | 三维场景 + 相机桥（快照捕获、原子恢复、回闭锁） |

### 验证

```bash
npx tsc -p scripts/tsconfig.test.json && node .tmp-test/scripts/verify-session.js
```

78 项断言覆盖：不可变与快照隔离、序列化往返、严格拒绝 vs 兼容读取的全部分支、播放/暂停/继续/seek/取消/重播/零时长、中断后基线恢复、重新导入与坏文件隔离、Object URL 回收与坏文件拒绝。

项目仅实现前端基础实验流程，后续可扩展真实 CFD / FEM 数据导入、网格解析、测量工具和实验结果导出。
