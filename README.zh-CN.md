<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/banner-zh-dark.png">
  <img src="assets/readme/banner-zh-light.png" alt="Open Energy Map：可追溯到来源的建筑能耗。首个城市：慕尼黑">
</picture>

<p align="center">一个交互式网络地图，基于开放数据逐栋估算建筑的供暖需求。<br>结果以区间而非单一数值给出，每一项输入都可以追溯到来源。<br>第一座城市是慕尼黑。</p>

<p align="center">
  <a href="https://chenxiachan.github.io/open-energy-map/"><img alt="打开地图" src="https://img.shields.io/badge/%E6%89%93%E5%BC%80%E5%9C%B0%E5%9B%BE-chenxiachan.github.io%2Fopen--energy--map-6b5ce7?style=flat-square"></a>
  <a href="https://youtu.be/90e-aEyOkDE"><img alt="演示视频，1 分钟" src="https://img.shields.io/badge/%E6%BC%94%E7%A4%BA%E8%A7%86%E9%A2%91-1_%E5%88%86%E9%92%9F-e08a3c?style=flat-square&logo=youtube&logoColor=white"></a>
  <a href="#许可"><img alt="许可：PolyForm Noncommercial 1.0.0 和 CC BY-NC 4.0" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-PolyForm_NC_%C2%B7_CC_BY--NC-59636e?style=flat-square"></a>
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

Open Energy Map 将开放数据逐栋对齐：OpenStreetMap 轮廓、巴伐利亚 LoD2 建筑模型、2022 年人口普查（Zensus 2022）和逐时气象数据。在此基础上，页面直接在浏览器中为任意一栋建筑建立能耗模型，无需安装，也无需注册账号。每栋建筑使用同一个模型，因此结果可以在三个尺度上阅读：单栋建筑、所在街道和整座城市。慕尼黑及周边是第一个地区；OpenStreetMap、Zensus 2022 和 ERA5 覆盖德国全境，同样的方法可以扩展到更多城市和地区。

## 功能

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/features-zh-dark.jpg">
  <img src="assets/readme/features-zh-light.jpg" alt="地图的四个画面：单栋建筑的三维模型和区间、带来源的输入参数表、全市单位面积供暖需求图层、三维街区漫游">
</picture>

- **单栋建模。** 点击一栋楼或搜索地址，页面即建立逐时热模型，给出供暖需求、终端能源、CO₂ 排放和峰值负荷的 P10–P90 区间。
- **热平衡。** 按构件给出热损失和得热（墙、窗、屋顶、地面、通风、太阳得热和内部得热），并显示在三维立面上；太阳位置可调到一年中的任意时刻。
- **可追溯的输入。** 每项输入都标注来源等级：实测、已发表表格、假设、用户输入或账单标定。引自文献的数值注明出处，能定位到页码的直接链接到该页。自检项说明不确定性来自哪里，另有一张卡片显示补充哪项数据最能缩小区间。
- **账单标定与改造。** 输入年度能源账单后，用贝叶斯方法（序贯蒙特卡洛）缩小区间。改造页在同一模型上比较各项改造措施，同样给出区间。
- **全市图层。** 205,505 栋供暖建筑的模型结果汇总到 Zensus 的 100 m 网格（27,295 格）：单位面积供暖需求、热需求密度（采用地方供热规划的分级，KEA-BW）、模型与同类建筑账单的对比，以及 LoD2 几何和街景照片的覆盖情况。每个着色格至少包含 5 栋供暖建筑，任何颜色都不对应单一地址。
- **三维街景。** 所选建筑周围的 LoD2 建筑和单棵树木，并附 Mapillary 街景照片。地形和航拍目前只覆盖慕尼黑工业大学主楼一带。
- **导出。** 每栋建筑都可以导出 EnergyPlus 输入文件（IDF）和气象文件（EPW）。
- **语言。** 英文、德文和中文，在页面右上角切换。

## 方法

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

任意一栋建筑的 **方法与导出** 页逐条说明每一步的假设和来源。

## 数据与许可

| 数据 | 来源 | 许可 |
|---|---|---|
| 建筑轮廓和标签 | © OpenStreetMap 贡献者 | ODbL 1.0 |
| LoD2 建筑模型、DGM1 地形、DOP40 正射影像、单棵树木 | 巴伐利亚测绘局（Bayerische Vermessungsverwaltung） | CC BY 4.0 |
| 2022 年人口普查 100 m 网格数据 | 联邦和州统计局（Statistische Ämter des Bundes und der Länder） | dl-de/by-2-0 |
| 逐时气象（ERA5） | Open-Meteo、哥白尼气候变化服务 | CC BY 4.0 |
| 街景照片（运行时加载） | Mapillary | CC BY-SA 4.0 |
| 底图（运行时加载） | OpenFreeMap | © OpenMapTiles、© OpenStreetMap 贡献者 |
| 材质贴图 | ambientCG | CC0 1.0 |

已发表的表格和标准，例如 IWU / TABULA 建筑类型学、DIN V 18599、GEG 2024、Heizspiegel München 2018 和 Loga 等（2019），均在使用处注明出处。完整列表见地图起始页底部。

## 给 AI 智能体用

命令行工具和 MCP 服务以 JSON 返回一栋楼的模型：每个结果都有区间，每项输入都有来源等级和出处。LLM 智能体用它，就能引用可追溯的建筑能耗。它们和地图用同一套模块和数据，只需要 Node.js，离线即可运行。

```bash
node agent/oem.mjs building --address "Schellingstraße 51, München"
claude mcp add open-energy-map -- node /path/to/open-energy-map/agent/oem.mjs mcp
```

选项、MCP 工具和返回字段见 [agent/README.md](agent/README.md)（英文）。

## 本地运行

地图是静态网站，无需构建。用任意静态服务器提供该文件夹即可：

```bash
git clone https://github.com/chenxiachan/open-energy-map.git
cd open-energy-map
python3 -m http.server 8000
```

然后打开 <http://127.0.0.1:8000/>。仓库约 100 MB，大部分是预处理过的地理数据。MapLibre GL JS、three.js 和底图需要联网加载。

## 仓库结构

```
index.html    页面
css/          样式
js/           模型、地图、三维视图和界面（ES 模块）
agent/        给 LLM 智能体用的命令行工具和 MCP 服务
data/         为地图预处理的开放数据；全市结果在 data/city/
assets/       材质贴图；logo 在 assets/brand/；本 README 的图片在 assets/readme/
LICENSE       许可条款
```

## 引用

请以 "Open Energy Map, (c) 2026 Xia Chen" 注明出处，并保留许可声明。学术引用：

```bibtex
@software{chen2026openenergymap,
  author = {Chen, Xia},
  title  = {Open Energy Map},
  year   = {2026},
  url    = {https://github.com/chenxiachan/open-energy-map},
  note   = {Georg Nemetschek Institute Artificial Intelligence for the Built World, Technical University of Munich}
}
```

## 许可

本项目分两部分许可：

- **代码和模型**（index.html、css/、js/）：[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。
- **计算结果、为本项目整理的数据和文字**（data/city/ 及其他非第三方数据文件）：[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)。

学术和个人使用免费，须注明出处。就代码而言，教育机构、公共研究机构和政府机构的使用，不论经费来源，均视为非商业用途。商业用途（例如用于收费的产品、服务或咨询项目）需要另行授权，请先联系 x.c.chen@tum.de。第三方数据按上表所列的各自许可。

© 2026 Xia Chen（慕尼黑工业大学 [Georg Nemetschek Institute](https://www.mdsi.tum.de/gni/research-at-gni/) 博士后研究员）。许可全文（英文）见 [LICENSE](LICENSE)。

## 联系

欢迎反馈，尤其是估算结果明显偏离的建筑。请提交 [issue](https://github.com/chenxiachan/open-energy-map/issues)，或发邮件至 x.c.chen@tum.de。

<br>

<p align="center">
  <a href="https://chenxiachan.github.io/open-energy-map/"><img src="assets/brand/logo.svg" width="44" alt="Open Energy Map"></a><br>
  <sub>由 <a href="https://chenxiachan.github.io/">Xia Chen</a> 在慕尼黑工业大学 <a href="https://www.mdsi.tum.de/gni/research-at-gni/">Georg Nemetschek Institute</a> 制作</sub>
</p>
