<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/banner-zh-dark.png">
  <img src="assets/readme/banner-zh-light.png" alt="Open Energy Map：可追溯到来源的建筑能耗。首个城市：慕尼黑">
</picture>

<p align="center">一个交互式网络地图，基于开放数据逐栋估算建筑的供暖需求。<br>结果以区间而非单一数值给出，每一项输入都可以追溯到来源。<br>第一座城市是慕尼黑。</p>

<p align="center">
  <a href="https://chenxiachan.github.io/open-energy-map/"><img alt="打开地图" src="https://img.shields.io/badge/%E6%89%93%E5%BC%80%E5%9C%B0%E5%9B%BE-chenxiachan.github.io%2Fopen--energy--map-6b5ce7?style=flat-square"></a>
  <a href="https://youtu.be/90e-aEyOkDE"><img alt="演示视频，1 分钟" src="https://img.shields.io/badge/%E6%BC%94%E7%A4%BA%E8%A7%86%E9%A2%91-1_%E5%88%86%E9%92%9F-e08a3c?style=flat-square&logo=youtube&logoColor=white"></a>
  <a href="#引用与许可"><img alt="许可：PolyForm Noncommercial 1.0.0 和 CC BY-NC 4.0" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-PolyForm_NC_%C2%B7_CC_BY--NC-59636e?style=flat-square"></a>
  <img alt="语言：英文、德文、中文" src="https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-EN_%C2%B7_DE_%C2%B7_%E4%B8%AD%E6%96%87-59636e?style=flat-square">
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

<p align="center">
  <a href="https://youtu.be/90e-aEyOkDE"><img src="assets/readme/video.jpg" width="760" alt="演示视频：Open Energy Map: Munich，从一栋楼到整座城市（1 分钟，YouTube）"></a><br>
  <sub>从一栋楼到整座城市 · YouTube 1 分钟，英文字幕 · 页面默认英文，可在右上角切换为中文或德文</sub>
</p>

> [!NOTE]
> 本项目是研究原型，仍在开发中。结果为估算值，仅供参考，不能替代能源证书或现场评估。

## 概述

Open Energy Map 将开放数据逐栋对齐：OpenStreetMap 轮廓、巴伐利亚 LoD2 建筑模型、2022 年人口普查和逐时气象数据。页面据此在浏览器里为任意一栋建筑建立能耗模型，无需安装，也无需注册。每栋楼用同一个模型，所以结果可以在单栋、街道和全市三个尺度上阅读。OpenStreetMap、人口普查和 ERA5 覆盖德国全境，同样的方法可以扩展到更多城市和地区。

## 功能

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/features-zh-dark.jpg">
  <img src="assets/readme/features-zh-light.jpg" alt="地图的四个画面：单栋建筑的三维模型和区间、带来源的输入参数表、全市单位面积供暖需求图层、三维街区漫游">
</picture>

- **单栋建模。** 点一栋楼或搜索地址，逐时热模型给出供暖需求、终端能源、CO₂ 和峰值负荷的 P10–P90 区间。
- **可追溯的输入。** 每项输入都标注来源等级（实测、已发表表格、假设、用户输入、账单标定），并注明文献和页码。页面说明不确定性来自哪里，以及补充哪项数据最能缩小区间。
- **三维热平衡。** 按构件给出热损失和得热，也显示在三维立面上，太阳可调到一年中任意时刻。
- **账单标定与改造。** 输入年度账单后用贝叶斯方法缩小区间；改造措施在同一模型上比较。
- **全市图层。** 205,505 栋供暖建筑汇总到人口普查的 100 m 网格（27,295 格），包括地方供热规划用的热需求密度。任何颜色都不对应单一地址。
- **三维街景。** 所选建筑周围的 LoD2 建筑、单棵树木和街景照片。
- **导出。** EnergyPlus（IDF、EPW）和 [CityGML Energy ADE 3.0](https://github.com/tudelft3d/Energy_ADE)，带每项输入的区间和来源等级。
- **给 AI 智能体用。** MCP 服务以 JSON 返回同一个模型，智能体就能引用可追溯的建筑能耗（见下）。

## 给 AI 智能体用

<p align="center"><img src="assets/readme/mcp-demo.gif" width="880" alt="Claude Code 通过 MCP 向 Open Energy Map 查询 Schellingstraße 51，回答里给出区间、主要不确定来源和改造假设"></p>
<p align="center"><sub>一次真实的 Claude Code 会话的回放（<a href="assets/readme/mcp-demo.mp4">MP4</a>）。提问、工具调用和回答都是原样，工具返回的 JSON 做了摘要，路径做了缩短。</sub></p>

MCP 服务以 JSON 返回一栋楼的模型：每个结果都有区间，每项输入都有来源等级和出处。它和地图用同一套模块和数据，只需要 Node.js 18 或更高版本，在你的电脑上离线运行（stdio），所以任何能运行本地 MCP 服务的客户端都能用。先克隆仓库：

```bash
git clone https://github.com/chenxiachan/open-energy-map.git && cd open-energy-map
```

**Claude Code**

```bash
claude mcp add open-energy-map -- node agent/oem.mjs mcp
```

这样只对当前文件夹生效；加上 `--scope user` 并写 `agent/oem.mjs` 的绝对路径，就能在任何目录使用。

**Claude Desktop、Cursor、Windsurf、Gemini CLI** 和大多数客户端，在各自的 MCP 配置文件的 `mcpServers` 下加同样一项：

```json
{
  "mcpServers": {
    "open-energy-map": { "command": "node", "args": ["/path/to/open-energy-map/agent/oem.mjs", "mcp"] }
  }
}
```

<details>
<summary>VS Code（Copilot 智能体模式）、OpenAI Codex CLI</summary>

VS Code，写在 `.vscode/mcp.json`：

```json
{
  "servers": {
    "open-energy-map": { "type": "stdio", "command": "node", "args": ["/path/to/open-energy-map/agent/oem.mjs", "mcp"] }
  }
}
```

Codex CLI，写在 `~/.codex/config.toml`：

```toml
[mcp_servers.open-energy-map]
command = "node"
args = ["/path/to/open-energy-map/agent/oem.mjs", "mcp"]
```

文件名和键名按各客户端 2026 年 11 月的文档；如有变化，以客户端文档为准。只能连接远程（HTTP）服务的网页聊天应用暂时用不了。
</details>

然后直接问，比如："慕尼黑 Schellingstraße 51 一年要多少供暖能耗？这个数有多可靠？"智能体会给出区间、主要影响因素及其来源等级，以及这栋楼在地图上的链接。告诉它你知道的情况（换了窗、装了热泵），它会把这些作为用户填写再算一次。

> [!TIP]
> **要指定某一栋楼，给编号比给地址准。** 一个地址可能对应几栋楼（比如学校和它的体育馆），慕尼黑周边几个镇也有同名的街道和门牌；这时工具会返回候选，不会替你猜。两个编号都能唯一确定一栋楼：[**OSM 编号**](https://www.openstreetmap.org/way/34107320)（`w34107320`，在地图地址栏的 `#b=w34107320@…` 里，也在 *OSM ↗* 链接背后）和 [**LoD2 编号**](https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2)（`DEBY_LOD2_4958835`，巴伐利亚 LoD2 CityGML 里的 `gml:id`，鼠标悬停 *LoD2 ↗* 或在"参数与来源"页签的几何卡片里可以看到）。

<details>
<summary>工具和命令行</summary>

- `find_building`：查地址和楼名，返回 OSM 编号、邮编和地图链接。
- `building_energy`：按 OSM 编号、LoD2 编号、坐标或地址返回一栋楼的模型。

```bash
node agent/oem.mjs building --id w34107320
node agent/oem.mjs building --lod2 DEBY_LOD2_4958835 --assume refurbished.windows=yes --assume system=hp_air
node agent/oem.mjs energy-ade --address "Schellingstraße 51, München" --out schellingstr51.gml
```

选项、编号和返回字段见 [agent/README.md](agent/README.md)（英文）。
</details>

## 方法与数据

任意一栋建筑的 **方法与导出** 页逐条说明每一步的假设和来源。

<details>
<summary>方法，逐步说明</summary>

| 步骤 | 做法 | 主要来源 |
|---|---|---|
| 几何 | OSM 轮廓；LoD2 覆盖轮廓时，高度、屋顶和层数取自巴伐利亚 LoD2 模型；由相邻建筑识别共用墙；参考面积按 GEG 计算 | OpenStreetMap、LoD2、GEG 2024 |
| 遮挡与日照 | 对 150 m 内所有建筑做光线追踪；由地平线扫描得到天空可视因子；立面辐照按 Hay 和 Davies 模型计算 | ERA5 |
| 气象 | 2010 至 2025 年逐时数据；用简化的 Sandia 方法生成典型气象年；标定时使用账单年份的实际气象 | Open-Meteo（ERA5） |
| 构造 | 建成年代先验取自建筑所在 100 m 网格的 Zensus 2022 年代分布；构件 U 值、气密性和改造比例按年代分级 | Zensus 2022、IWU / TABULA |
| 热模型 | 按 ISO 13790 的逐时 5R1C 模型；非住宅的通风和使用时段按 DIN V 18599 | ISO 13790、DIN V 18599 |
| 终端能源 | 锅炉用季节效率，热泵用逐时 COP；一次能源、CO₂ 因子和能效等级按 GEG | GEG 2024 |
| 标定 | 从建成年代到使用行为的分层先验；序贯蒙特卡洛，自适应退火和 pCN 移动 | 年度账单 |
| 与账单对比 | 将模型结果换算到实测能耗的典型水平，再与同类建筑的账单比较 | Heizspiegel München 2018、Loga 等（2019） |
</details>

<details>
<summary>数据与许可</summary>

| 数据 | 来源 | 许可 |
|---|---|---|
| 建筑轮廓、标签和地址 | © OpenStreetMap 贡献者 | ODbL 1.0 |
| LoD2 建筑模型、DGM1 地形、DOP40 正射影像、单棵树木 | 巴伐利亚测绘局（Bayerische Vermessungsverwaltung） | CC BY 4.0 |
| 2022 年人口普查 100 m 网格数据 | 联邦和州统计局（Statistische Ämter des Bundes und der Länder） | dl-de/by-2-0 |
| 逐时气象（ERA5） | Open-Meteo、哥白尼气候变化服务 | CC BY 4.0 |
| 街景照片（运行时加载） | Mapillary | CC BY-SA 4.0 |
| 底图（运行时加载） | OpenFreeMap | © OpenMapTiles、© OpenStreetMap 贡献者 |
| 材质贴图 | ambientCG | CC0 1.0 |

已发表的表格和标准，例如 IWU / TABULA 建筑类型学、DIN V 18599、GEG 2024、Heizspiegel München 2018 和 Loga 等（2019），均在使用处注明出处。完整列表见地图起始页底部。
</details>

## 本地运行

地图是静态网站，没有构建步骤：用任意静态网页服务器打开这个文件夹即可，例如 `python3 -m http.server 8000`，然后访问 <http://127.0.0.1:8000/>。仓库约 100 MB，大部分是整理好的地理数据；MapLibre GL JS、three.js 和底图从网上加载。

<details>
<summary>目录结构</summary>

```
index.html    页面
css/          样式
js/           模型、地图、三维视图和界面（ES 模块）
agent/        给 LLM 智能体用的命令行工具和 MCP 服务
data/         为地图预处理的开放数据；全市结果在 data/city/
assets/       材质贴图；logo 在 assets/brand/；本 README 的图片在 assets/readme/
LICENSE       许可条款
```
</details>

## 引用与许可

请以 "Open Energy Map, (c) 2026 Xia Chen" 注明出处，并保留许可声明。

<details>
<summary>BibTeX</summary>

```bibtex
@software{chen2026openenergymap,
  author = {Chen, Xia},
  title  = {Open Energy Map},
  year   = {2026},
  url    = {https://github.com/chenxiachan/open-energy-map},
  note   = {Georg Nemetschek Institute Artificial Intelligence for the Built World, Technical University of Munich}
}
```
</details>

- **代码和模型**（index.html、css/、js/、agent/）：[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。
- **计算结果、为本项目整理的数据和文字**：[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)。第三方数据按各自的许可。

学术和个人使用免费，须注明出处；教育机构、公共研究机构和政府机构的使用视为非商业用途。商业用途（例如收费的产品、服务或咨询项目）需要另行授权：x.c.chen@tum.de。© 2026 Xia Chen，慕尼黑工业大学 [Georg Nemetschek Institute](https://www.mdsi.tum.de/gni/research-at-gni/)；许可全文（英文）见 [LICENSE](LICENSE)。

## 联系

欢迎反馈，尤其是估算结果明显偏离的建筑。请提交 [issue](https://github.com/chenxiachan/open-energy-map/issues)，或发邮件至 x.c.chen@tum.de。

<br>

<p align="center">
  <a href="https://chenxiachan.github.io/open-energy-map/"><img src="assets/brand/logo.svg" width="44" alt="Open Energy Map"></a><br>
  <sub>由 <a href="https://chenxiachan.github.io/">Xia Chen</a> 在慕尼黑工业大学 <a href="https://www.mdsi.tum.de/gni/research-at-gni/">Georg Nemetschek Institute</a> 制作</sub>
</p>
