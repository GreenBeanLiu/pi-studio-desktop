# 3D 模型工作流设计（整理 + 完善）

> 你的设想：3D 模型工作流支持两种——① 图片生模型（图片可由 gpt-image-2 生成）；② 代码不断修改最后产出模型。
> **好消息：这两种 pi-studio 现在就已经基本实现了。** 本文把现状盘清，再指出真正要"完善"的两个增量，给出统一架构和分阶段落地。

---

## 0. 一句话结论

| 你的设想 | 现状 | 要完善的增量 |
|---|---|---|
| **① 图 → 模型**（图可 gpt-image-2 生成） | 图生/文生 3D 已上线（Tripo;Hi3D 10-23 已删，云中转） | **加一环：文字 → gpt-image-2 生图 → 图生 3D** 的一条龙（复用换装那套 gpt-image-2 编排） |
| **② 代码迭代 → 模型** | 代码建模已上线（pi-agent 手搓 three.js、自测、可增量 refine） | **闭环化：渲染 → AI 视觉评审 → 自动改码 → 再渲染**，用已有的 `vision-review` 当验收门 |

换句话说：**引擎都在，缺的是"把 gpt-image-2 接到图生 3D 前面"和"把视觉评审接回代码迭代里形成闭环"这两根线。**

---

## 1. 现状盘点（你已经拥有的 3D 家底）

| 能力 | 文件 | 说明 |
|---|---|---|
| **图生 / 文生 3D** | `src/main/model3d.ts` | 走云中转 `/model3d` → 服务端 Hatchet `gen-model-3d` → **Tripo(Hi3D 10-23 已删)** → R2 上的 glb，下载到本地。Tripo 支持文生+图生，Hi3D 纯图生。 |
| **代码建模（three.js）** | `src/main/code-model.ts` | 内嵌 **pi-agent** 在预置 `build-model.js` 骨架里手搓 `buildModel(THREE)`，用 **embedded node**（不依赖系统 node）导出 glb。带 **z-fighting 几何审计门**、自测 `MODEL_OK`、`object-to-threejs-procedural` skill；**已支持增量 refine**（`sourceId` → 拷贝上一版代码、agent 只做增量修改）。 |
| **Blender 建模** | `src/main/blender-model.ts`、`blender-setup.ts` | 驱动本机 Blender 出 glb（Windows 专属，见移植文档）。 |
| **AI 视觉还原度评审** | `src/main/vision-review.ts` | 把「参考图/提示词 + 模型渲染截图」发给视觉模型，返回 `{score:0-100, notes}`。灵感来自 threejs-object-sculptor 的「Screenshot Feedback Gate：像素对比不是权威，AI 视觉才是」。**目前只在生成后异步打分展示，还没接回迭代。** |
| **统一查看/历史/下载** | `Model3DPage.tsx` + `ModelViewer` | 一个 3D 页，多引擎共用 three.js 预览、历史画廊、下载、还原度徽章；历史项带 `mode: text/image/code/blender`。 |

> 所以现在的 3D 页**已经是多引擎统一页**了。你的两种模式，本质是「在这页上补两条线」。

---

## 2. 模式一：图 → 模型（含 gpt-image-2 生图）

### 目标管道
```
输入(文字描述 或 上传参考图)
   └─(可选,新)─ gpt-image-2 生成参考图  ──→  图生 3D(Tripo)  ──→  glb  ──→  视觉评审打分
```

### 现状 vs 要新建
- **已有**：`model3d.ts` 的 image 模式——上传一张参考图 → `/imagegen/reference` 落 R2 → `/model3d` 图生 3D。
- **要新建（P1，小而高价值）**：**文字 → gpt-image-2 → 图生 3D** 的串联。
  这和刚做完的**换装工作流是同一套编排**（`main/dressup.ts` 里 `genTryOn` 就是调 `/imagegen`(gpt-image-2) 拿 R2 图）：
  1. 用户给文字（如"一只赛博朋克机械猫"）
  2. 调 `/imagegen`(model=gpt-image-2) 生成一张干净的**产品视角参考图**（白底、正面、居中）
  3. 把该 R2 图 URL 直接喂给现有 `/model3d` image 模式 → glb
  4. 复用 `vision-review` 打分

### 可选完善（P3）
- **多视角生图**：gpt-image-2 生成 正/侧/背 多张 → 用支持多图的图生 3D 提升重建质量（Tripo 有多视角输入；先单图跑通再说）。
- **候选图**：一次生 2–4 张让用户挑，或按 vision 质量自动选一张再转 3D。
- 生图提示词模板：强制"单主体、白底、正交视角、无阴影投影、居中"——对图生 3D 最友好。

---

## 3. 模式二：代码 → 模型（闭环迭代）

### 现状
`code-model.ts` 已经是"代码迭代"：
- pi-agent 写 `buildModel(THREE)`，**每改一版就 `node build-model.js test.glb` 自测**，遇 `MODEL_Z_FIGHTING` 自己错开，直到 `MODEL_OK`。
- `sourceId` 支持**增量 refine**：拷贝上一版代码，agent 按新指令只做增量修改。
- 但这是**"几何有效性"自测 + 用户每轮手动给指令**，还不是"看着渲染像不像"的自动闭环。

### 完善为「自主视觉闭环」（P2，你设想的精髓）
把已有零件接成一个环，agent 自己"照着目标改到像为止"：
```
① agent 出一版 build-model.js → 导出 glb
② 渲染 glb 出截图(正视 + 45° 两张)          ← ModelViewer 已能截图(saveThumbnail)
③ vision-review 打分 {score, notes}          ← vision-review.ts 已有
④ score < 阈值(如 85) 且未超最大轮数
      → 把 notes(差异点评) 当作下一轮 refine 指令喂回 agent → 回到 ①
⑤ 达标 或 到轮数上限 → 定稿
```
- **所有零件都已存在**：`code-model`(写码/导出) + `ModelViewer` 截图 + `vision-review`(打分)。
  **要写的只是这个 orchestrator**：串起"导出→渲染截图→评审→把 notes 回灌 refine"，加一个**验收门**（分数阈值 / 最大轮数）。
- 相比现在：把"用户每轮手动纠"换成"AI 视觉每轮自动纠"，这正是 threejs-object-sculptor 的 Screenshot Feedback Gate 思路，`vision-review.ts` 的注释里也点了这个来源。

### 代码建模的"语言" —— 【已定：锁 three.js】
- **代码建模一律用 three.js 程序化**（已 built、跨平台、embedded node 导出、产物可动画/可拆解）。
  这个工作流的价值在"**改到像为止的快速视觉闭环**"，three.js 在迭代速度、LLM 稳定性、跨平台、零依赖上全面占优。
- **Blender = 窄场景、Windows 专属、不移植 mac**（用户明确不在 mac 上做 3D）。只在"**代码可控 + 需要 布尔(挖孔) / 细分·倒角(圆角平滑) / 真材质(木纹砖墙拉丝纹理)**"这类 three.js 图元表达不了、又愿接受"慢+易崩+要装软件"的场景才用。放 P3，非默认。Mac 版直接隐藏/降级该引擎。
- OpenSCAD 等：暂不碰。

### 选型速记（三条路各管什么）
| 目标模型 | 走哪条 |
|---|---|
| **有机 / 写实 / 带细节纹理**（角色、动物、道具毛发肌理） | **图生 3D**（Tripo）——别写代码 |
| **硬表面 / 可编辑可动画**，方块·圆柱拼得出、纯色/金属塑料质感 | **Three.js 代码建模（默认）** |
| **代码可控 + 布尔/细分/真材质**（挖孔、圆角平滑、真实贴图） | **Blender**（窄场景、Windows 专属、P3） |

> 一句话记忆：**圆角/挖孔/木纹砖墙拉丝 → Blender；方块圆柱硬表面 → three.js；毛发肌理写实 → 图生 3D。**

---

## 4. 统一架构与 UX

- **一个「3D 模型」页**（现在的 `Model3DPage` 已是多引擎），顶部**模式切换**：`图生模型` / `代码建模`。
- 图生模式下加一个开关：`上传参考图` ↔ `AI 生图(gpt-image-2)`（后者填文字）。
- 代码模式下加一个开关：`一次生成` ↔ `自动优化(视觉闭环)`（后者跑 §3 的环，UI 显示每轮分数/轮次）。
- **共用**：ModelViewer 预览、历史画廊、下载 glb、还原度徽章、AI 评审 —— 全部已有，不重造。

后端零改动：图生 3D 与 gpt-image-2 都走现有中转 `trail-api.glanger.xyz`（`/model3d`、`/imagegen`）。
代码建模全在本机（embedded node），也无需后端。

---

## 5. 分阶段落地建议

| 阶段 | 内容 | 大小 | 依赖 |
|---|---|---|---|
| **P1** | 模式一加「gpt-image-2 生图 → 图生 3D」串联 + UI 开关 | 小 | 复用换装的 gpt-image-2 编排 + 现有 `/model3d` |
| **P2** | 模式二「视觉闭环」orchestrator（render→review→revise + 验收门） | 中 | 复用 code-model / ModelViewer 截图 / vision-review |
| **P3** | 多视角生图、多角度评审、候选图选择；（可选）Blender 引擎补 mac | 中 | 增强项 |

P1 最快见效（跟换装几乎同构）；P2 是你设想里最有意思、最"自动"的部分。

---

## 6. 要你拍板的决策点

1. ~~代码建模语言~~ **【已定】锁 three.js**；Blender 仅"布尔/细分/真材质"窄场景走 P3，Windows 专属不移植 mac。
2. ~~闭环模式~~ **【已定】全自动**：跑到 85 分或 5 轮才停，可随时叫停，保留每轮历史。
3. ~~阈值与轮数~~ **【已定】默认 85 分 / 最多 5 轮**。
4. ~~图生模型单图/多视角~~ **【已定】先只做单图**；多视角放 P3。
5. ~~候选图~~ **【已定】gpt-image-2 一次生 1 张直转**（不做候选挑选，P3 再说）。

> 全部决策已敲定 → 从 P1 开工：图生模式加「gpt-image-2 生图 → 图生 3D」串联。

---

## 附：关键文件速查

| 关注点 | 文件 |
|---|---|
| 图生/文生 3D(Tripo) | `src/main/model3d.ts` |
| 代码建模(three.js, 迭代) | `src/main/code-model.ts` |
| AI 视觉评审(闭环反馈信号) | `src/main/vision-review.ts` |
| Blender 引擎 | `src/main/blender-model.ts`、`blender-setup.ts` |
| 3D 页 / 预览 / 历史 | `src/renderer/src/components/Model3DPage.tsx`、`ModelViewer` |
| gpt-image-2 编排范例(照抄) | `src/main/dressup.ts`(`genTryOn` 调 `/imagegen`) |
| 云中转端点 | `/model3d`、`/imagegen`（均已放行、已上线） |
