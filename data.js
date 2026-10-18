/* ============================================================
 * digipick —— 参数数据层
 * ------------------------------------------------------------
 * ⚠️ 重要：下面所有数据均为**演示样例**，用于跑通站点的功能逻辑。
 *    它们不是厂商官方数据，价格也不是实时报价。
 *    正式上线前必须替换为从「厂商官网 / 官方规格页」整理的权威数据。
 *
 * 每个品类的 specs 字段可以完全不同 —— specFields 定义了
 * 「这个品类的产品要展示哪些参数、按什么顺序展示、怎么显示」。
 * 加一个新品类只需要在这里加一组，前端不用改一行代码。
 * ============================================================ */

/* 大类（subs 为空表示不再细分）。产品用 category + sub 两个字段定位。 */
const CATEGORIES = [
  { id: 'phone',   name: '手机' },
  { id: 'tablet',  name: '平板' },
  { id: 'laptop',  name: '笔记本电脑' },
  { id: 'desktop', name: '台式机', subs: [
    { id: 'mini',  name: '迷你主机' },
    { id: 'tower', name: '整机' },
    { id: 'diy',   name: 'DIY装机' },
  ] },
  { id: 'wearable', name: '智能穿戴', subs: [
    { id: 'watch',   name: '智能手表' },
    { id: 'band',    name: '智能手环' },
    { id: 'glasses', name: '智能眼镜' },
  ] },
  { id: 'camera', name: '相机', subs: [
    { id: 'mirrorless', name: '微单' },
    { id: 'dslr',       name: '单反' },
    { id: 'action',     name: '运动相机' },
    { id: 'compact',    name: '卡片机' },
  ] },
  { id: 'lens', name: '镜头', subs: [
    { id: 'zoom',  name: '变焦' },
    { id: 'prime', name: '定焦' },
  ] },
  { id: 'peripheral', name: '电脑外设', subs: [
    { id: 'keyboard', name: '键盘' },
    { id: 'mouse',    name: '鼠标' },
    { id: 'monitor',  name: '显示器' },
  ] },
  { id: 'accessory', name: '配件', subs: [
    { id: 'power',   name: '充电与电源' },
    { id: 'audio',   name: '音频' },
    { id: 'storage', name: '存储' },
  ] },
];

/* 每个品类展示哪些参数列。buy = 是否作为「选购时最该看」的高亮参数 */
const SPEC_FIELDS = {
  phone: [
    { key: 'soc',      label: '处理器' },
    { key: 'ram',      label: '内存' },
    { key: 'storage',  label: '存储' },
    { key: 'screen',   label: '屏幕' },
    { key: 'battery',  label: '电池' },
    { key: 'charge',   label: '快充' },
    { key: 'camera',   label: '主摄' },
    { key: 'weight',   label: '重量' },
  ],
  laptop: [
    { key: 'cpu',      label: '处理器' },
    { key: 'gpu',      label: '显卡' },
    { key: 'ram',      label: '内存' },
    { key: 'storage',  label: '硬盘' },
    { key: 'screen',   label: '屏幕' },
    { key: 'weight',   label: '重量' },
    { key: 'battery',  label: '电池' },
  ],
  tablet: [
    { key: 'soc',      label: '处理器' },
    { key: 'ram',      label: '内存' },
    { key: 'storage',  label: '存储' },
    { key: 'screen',   label: '屏幕' },
    { key: 'battery',  label: '电池' },
    { key: 'weight',   label: '重量' },
  ],
  accessory: [
    { key: 'type',     label: '类型' },
    { key: 'power',    label: '功率/容量' },
    { key: 'interface',label: '接口' },
    { key: 'weight',   label: '重量' },
  ],
  desktop: [
    { key: 'cpu',      label: '处理器' },
    { key: 'gpu',      label: '显卡' },
    { key: 'ram',      label: '内存' },
    { key: 'storage',  label: '硬盘' },
    { key: 'ports',    label: '接口' },
    { key: 'size',     label: '体积' },
  ],
  wearable: [
    { key: 'screen',   label: '屏幕' },
    { key: 'battery',  label: '续航' },
    { key: 'sensors',  label: '传感器' },
    { key: 'weight',   label: '重量' },
    { key: 'water',    label: '防水' },
  ],
  camera: [
    { key: 'sensor',   label: '传感器' },
    { key: 'video',    label: '视频' },
    { key: 'mount',    label: '镜头' },
    { key: 'screen',   label: '屏幕' },
    { key: 'weight',   label: '重量' },
  ],
  peripheral: [
    { key: 'type',     label: '类型' },
    { key: 'size',     label: '尺寸' },
    { key: 'interface',label: '连接' },
    { key: 'weight',   label: '重量' },
  ],
  lens: [
    { key: 'mount',    label: '卡口' },
    { key: 'range',    label: '焦段' },
    { key: 'aperture', label: '最大光圈' },
    { key: 'filter',   label: '滤镜口径' },
    { key: 'weight',   label: '重量' },
  ],
};

/* ------------------------------------------------------------
 * 产品库
 * ------------------------------------------------------------
 * price        ：参考价（元）。demo 价格，非实时
 * commissionRate：该商品在联盟的佣金率。0 表示无推广链接
 *                 真值按平台季度调整，注册联盟后台看官方比例表
 * tags         ：一句话卖点，选购时的关键差异
 * ------------------------------------------------------------
 * offers：渠道货（可选）—— 型号 ↔ 平台的 SKU 映射
 * ------------------------------------------------------------
 * 价格跟着 SKU 走，不跟着型号走：同一款手机在京东、淘宝是不同的货。
 * 拿到联盟账号后，给产品补上：
 *
 *   offers: [
 *     { platform: 'jd', sku: '100012345678', pid: '你的推广位' },
 *     { platform: 'tb', itemId: '654321' },
 *   ]
 *
 * 之后 node refresh-price.mjs --provider jd 就会按这些 SKU 去取真实价格，
 * 多平台时取最低价当展示价（详见 refresh-price.mjs 头部的说明）。
 * 没有 offers 的产品继续沿用上面的参考价，站点一切照常。
 * ---------------------------------------------------------- */
const PRODUCTS = [
  /* ===== 手机 ===== */
  {
    id: 'phone-redmi-turbo4', category: 'phone', brand: 'Redmi', name: 'Redmi Turbo 4',
    price: 1999, commissionRate: 0.015,
    specs: { soc: '天玑 8400-Ultra', ram: '12GB', storage: '256GB', screen: '6.67" 1.5K OLED 120Hz',
             battery: '6550mAh', charge: '90W', camera: '5000万 OIS', weight: '203g' },
    tags: ['2000 元档性能最强', '电池巨大', '屏幕素质越级'],
    forWho: '预算卡在 2000、主要打游戏和日常使用',
  },
  {
    id: 'phone-redmi-k80', category: 'phone', brand: 'Redmi', name: 'Redmi K80',
    price: 2499, commissionRate: 0.015,
    specs: { soc: '骁龙 8 Gen 3', ram: '12GB', storage: '256GB', screen: '6.67" 2K OLED 120Hz',
             battery: '6550mAh', charge: '90W', camera: '5000万 OIS', weight: '206g' },
    tags: ['2K 屏', '上代旗舰芯片', '续航强'],
    forWho: '想要旗舰芯片 + 好屏幕，但预算不到 3000',
  },
  {
    id: 'phone-oneplus-ace5', category: 'phone', brand: '一加', name: '一加 Ace 5',
    price: 2599, commissionRate: 0.02,
    specs: { soc: '骁龙 8 Gen 3', ram: '12GB', storage: '256GB', screen: '6.78" 1.5K OLED 120Hz',
             battery: '6415mAh', charge: '80W', camera: '5000万 OIS', weight: '206g' },
    tags: ['游戏调度激进', '做工手感好'],
    forWho: '重度手游玩家，看重帧率稳定性',
  },
  {
    id: 'phone-iqoo-neo10', category: 'phone', brand: 'iQOO', name: 'iQOO Neo10',
    price: 2799, commissionRate: 0.02,
    specs: { soc: '骁龙 8 Gen 3', ram: '12GB', storage: '256GB', screen: '6.78" 1.5K OLED 144Hz',
             battery: '6100mAh', charge: '120W', camera: '5000万 OIS', weight: '199g' },
    tags: ['120W 快充', '144Hz 高刷', '独显芯片'],
    forWho: '在意充电速度和游戏高帧',
  },
  {
    id: 'phone-oneplus-13t', category: 'phone', brand: '一加', name: '一加 13T',
    price: 3399, commissionRate: 0.02,
    specs: { soc: '骁龙 8 至尊版', ram: '12GB', storage: '256GB', screen: '6.32" 1.5K OLED 120Hz',
             battery: '6260mAh', charge: '80W', camera: '5000万 OIS', weight: '185g' },
    tags: ['小屏 + 当代旗舰芯片', '罕见组合', '单手握持好'],
    forWho: '想要小屏手感但不要小屏性能妥协',
  },
  {
    id: 'phone-oppo-findx8', category: 'phone', brand: 'OPPO', name: 'OPPO Find X8',
    price: 4199, commissionRate: 0.025,
    specs: { soc: '天玑 9400', ram: '12GB', storage: '256GB', screen: '6.59" 1.5K OLED 120Hz',
             battery: '5630mAh', charge: '80W', camera: '5000万 三摄 哈苏', weight: '193g' },
    tags: ['影像均衡', '哈苏色彩', '机身轻薄'],
    forWho: '拍照和手感都要，预算 4000 出头',
  },
  {
    id: 'phone-xiaomi15', category: 'phone', brand: '小米', name: '小米 15',
    price: 4299, commissionRate: 0.025,
    specs: { soc: '骁龙 8 至尊版', ram: '12GB', storage: '256GB', screen: '6.36" 1.5K OLED 120Hz',
             battery: '5400mAh', charge: '90W', camera: '5000万 三摄 徕卡', weight: '191g' },
    tags: ['小屏旗舰标杆', '徕卡影像', '手感一流'],
    forWho: '要小屏 + 顶级性能 + 好相机',
  },
  {
    id: 'phone-vivo-x200', category: 'phone', brand: 'vivo', name: 'vivo X200',
    price: 4299, commissionRate: 0.025,
    specs: { soc: '天玑 9400', ram: '12GB', storage: '256GB', screen: '6.67" 1.5K OLED 120Hz',
             battery: '5800mAh', charge: '90W', camera: '5000万 三摄 蔡司', weight: '197g' },
    tags: ['蔡司长焦', '续航好', '影像强'],
    forWho: '喜欢拍远景、拍人像',
  },
  {
    id: 'phone-iphone16', category: 'phone', brand: '苹果', name: 'iPhone 16',
    price: 5499, commissionRate: 0.005,
    specs: { soc: 'A18', ram: '8GB', storage: '128GB', screen: '6.1" OLED 60Hz',
             battery: '3561mAh', charge: '20W', camera: '4800万 双摄', weight: '170g' },
    tags: ['生态和二手保值', '视频拍摄强', '充电慢'],
    forWho: '已经在苹果生态里，或者很在意保值率',
  },
  {
    id: 'phone-huawei-mate70', category: 'phone', brand: '华为', name: '华为 Mate 70',
    price: 5499, commissionRate: 0.01,
    specs: { soc: '麒麟 9020', ram: '12GB', storage: '256GB', screen: '6.7" 1.5K OLED 120Hz',
             battery: '5300mAh', charge: '66W', camera: '5000万 三摄 红枫', weight: '203g' },
    tags: ['信号和通信强', '鸿蒙生态', '商务向'],
    forWho: '看重信号、续航稳定性和国产生态',
  },

  /* ===== 笔记本 ===== */
  {
    id: 'laptop-redmibook14', category: 'laptop', brand: 'Redmi', name: 'Redmi Book 14 2025',
    price: 2999, commissionRate: 0.02,
    specs: { cpu: '酷睿 i5-13500H', gpu: '核显', ram: '16GB', storage: '512GB SSD',
             screen: '14" 2.8K 120Hz', weight: '1.37kg', battery: '56Wh' },
    tags: ['3000 元内屏幕最好的之一', '办公够用'],
    forWho: '学生党、纯文档和网课，不打游戏',
  },
  {
    id: 'laptop-honor-x16pro', category: 'laptop', brand: '荣耀', name: '荣耀 MagicBook X16 Pro',
    price: 3999, commissionRate: 0.02,
    specs: { cpu: '酷睿 i5-13500H', gpu: '核显', ram: '16GB', storage: '1TB SSD',
             screen: '16" 2.5K 120Hz', weight: '1.75kg', battery: '75Wh' },
    tags: ['大屏 + 1TB', '接口齐全', '续航不错'],
    forWho: '要一块大屏做表、看资料，不太移动',
  },
  {
    id: 'laptop-xiaoxin-pro14', category: 'laptop', brand: '联想', name: '联想小新 Pro 14 2025',
    price: 4599, commissionRate: 0.02,
    specs: { cpu: '锐龙 R7-8845H', gpu: '核显', ram: '16GB', storage: '1TB SSD',
             screen: '14" 2.8K 120Hz', weight: '1.46kg', battery: '84Wh' },
    tags: ['轻薄本均衡之选', '性能释放好', '续航强'],
    forWho: '大多数人的「闭眼买」选择',
  },
  {
    id: 'laptop-matebook14', category: 'laptop', brand: '华为', name: '华为 MateBook 14 2025',
    price: 5299, commissionRate: 0.015,
    specs: { cpu: '酷睿 Ultra 5', gpu: '核显', ram: '16GB', storage: '1TB SSD',
             screen: '14.2" 2.8K 120Hz 触控', weight: '1.31kg', battery: '70Wh' },
    tags: ['3:2 触控屏适合办公', '多屏协同', '做工好'],
    forWho: '用华为手机，想要生态联动',
  },
  {
    id: 'laptop-thinkbook16p', category: 'laptop', brand: '联想', name: 'ThinkBook 16p 2025',
    price: 8499, commissionRate: 0.02,
    specs: { cpu: '锐龙 R9-8945HX', gpu: 'RTX 4060', ram: '32GB', storage: '1TB SSD',
             screen: '16" 3.2K 165Hz', weight: '2.1kg', battery: '80Wh' },
    tags: ['创作本：性能 + 好屏幕', '内存 32GB 起步'],
    forWho: '剪视频、跑 3D、还要能带出门',
  },
  {
    id: 'laptop-macbook-air-m4', category: 'laptop', brand: '苹果', name: 'MacBook Air 13 M4',
    price: 8999, commissionRate: 0.005,
    specs: { cpu: 'Apple M4', gpu: '10 核 GPU', ram: '16GB', storage: '256GB SSD',
             screen: '13.6" Liquid 视网膜', weight: '1.24kg', battery: '52.6Wh' },
    tags: ['无风扇静音', '续航极强', '存储加价贵'],
    forWho: '写代码、写文档、剪轻量视频，认 macOS',
  },
  {
    id: 'laptop-macbook-pro14-m4pro', category: 'laptop', brand: '苹果', name: 'MacBook Pro 14 M4 Pro',
    price: 12999, commissionRate: 0.005,
    specs: { cpu: 'Apple M4 Pro', gpu: '16 核 GPU', ram: '24GB', storage: '512GB SSD',
             screen: '14.2" XDR 120Hz', weight: '1.55kg', battery: '72.4Wh' },
    tags: ['XDR 屏', '专业级性能', '价格高'],
    forWho: '专业视频 / 音频 / 开发工作流',
  },
  {
    id: 'laptop-jiage17', category: 'laptop', brand: '机械革命', name: '机械革命 极光 X',
    price: 5999, commissionRate: 0.025,
    specs: { cpu: '锐龙 R7-8845H', gpu: 'RTX 4060', ram: '16GB', storage: '1TB SSD',
             screen: '16" 2.5K 165Hz', weight: '2.3kg', battery: '60Wh' },
    tags: ['6000 元内游戏本性价比', '散热一般', '噪音偏大'],
    forWho: '预算有限但要独显打游戏',
  },
  {
    id: 'laptop-asus-tianxuan6', category: 'laptop', brand: '华硕', name: '华硕天选 6',
    price: 7299, commissionRate: 0.025,
    specs: { cpu: '锐龙 R7-8845H', gpu: 'RTX 4060', ram: '16GB', storage: '1TB SSD',
             screen: '16" 2.5K 165Hz', weight: '2.2kg', battery: '90Wh' },
    tags: ['游戏本里做工和续航较好', '外观低调'],
    forWho: '要独显但不想太"电竞风"',
  },

  /* ===== 平板 ===== */
  {
    id: 'tablet-xiaomi-pad7', category: 'tablet', brand: '小米', name: '小米平板 7',
    price: 1999, commissionRate: 0.02,
    specs: { soc: '骁龙 7+ Gen 3', ram: '8GB', storage: '256GB', screen: '11.2" 3.2K 144Hz',
             battery: '8850mAh', weight: '500g' },
    tags: ['3.2K 高刷屏', '影音体验好'],
    forWho: '主要看剧、看电子书，偶尔记笔记',
  },
  {
    id: 'tablet-huawei-matepad11', category: 'tablet', brand: '华为', name: '华为 MatePad 11.5 S',
    price: 2299, commissionRate: 0.02,
    specs: { soc: '麒麟 9000WL', ram: '8GB', storage: '256GB', screen: '11.5" 2.8K 144Hz',
             battery: '8800mAh', weight: '515g' },
    tags: ['柔光屏护眼', '手写笔体验好'],
    forWho: '学生做笔记、看 PDF',
  },
  {
    id: 'tablet-ipad-air-m3', category: 'tablet', brand: '苹果', name: 'iPad Air 11 M3',
    price: 4799, commissionRate: 0.005,
    specs: { soc: 'Apple M3', ram: '8GB', storage: '128GB', screen: '11" Liquid 视网膜',
             battery: '7600mAh', weight: '460g' },
    tags: ['平板生态最成熟', '配件贵', '存储加价'],
    forWho: '想要平板里最省心的选择',
  },

  /* ===== 配件（佣金率通常明显高于整机）===== */
  {
    id: 'acc-gan-charger', category: 'accessory', sub: 'power', brand: '努比亚', name: '努比亚 65W 氮化镓充电器',
    price: 99, commissionRate: 0.08,
    specs: { type: '氮化镓充电器', power: '65W 双 C 口', interface: 'USB-C ×2', weight: '112g' },
    tags: ['一个头充手机 + 笔记本', '体积小'],
    forWho: '背包里只想带一个充电头',
  },
  {
    id: 'acc-powerbank', category: 'accessory', sub: 'power', brand: '绿联', name: '绿联 20000mAh 移动电源',
    price: 159, commissionRate: 0.08,
    specs: { type: '移动电源', power: '20000mAh / 30W', interface: 'USB-C + USB-A', weight: '430g' },
    tags: ['可上飞机', '给笔记本应急供电'],
    forWho: '出差、长途通勤',
  },
  {
    id: 'acc-earbuds', category: 'accessory', sub: 'audio', brand: 'Nothing', name: 'Nothing Ear (a)',
    price: 599, commissionRate: 0.06,
    specs: { type: '真无线降噪耳机', power: '单次 9.5h', interface: '蓝牙 5.3', weight: '4.8g/只' },
    tags: ['设计独特', '降噪够用', '价格比旗舰低一半'],
    forWho: '想要降噪但不想花上千',
  },
  {
    id: 'peripheral-keychron-k3', category: 'peripheral', sub: 'keyboard', brand: 'Keychron', name: 'Keychron K3 Pro 矮轴',
    price: 549, commissionRate: 0.06,
    specs: { type: '机械键盘 75%', size: '75% 配列', interface: 'USB-C / 蓝牙', weight: '420g' },
    tags: ['矮轴不累手', '可三设备切换', '便携'],
    forWho: '经常换设备、要带出门的键盘',
  },
  {
    id: 'peripheral-mx-master3s', category: 'peripheral', sub: 'mouse', brand: '罗技', name: 'MX Master 3S',
    price: 699, commissionRate: 0.05,
    specs: { type: '无线鼠标', size: '中大手', interface: '蓝牙 / Bolt 接收器', weight: '141g' },
    tags: ['静音微动', '横向滚轮', '多设备切换'],
    forWho: '一天要滚很多表格、想省手腕的人',
  },
  {
    id: 'peripheral-redmi-a27u', category: 'peripheral', sub: 'monitor', brand: 'Redmi', name: 'Redmi 显示器 A27U',
    price: 1099, commissionRate: 0.03,
    specs: { type: '4K 显示器', size: '27 英寸', interface: 'HDMI ×2 / DP', weight: '约 4.2kg' },
    tags: ['4K 修图够用', '出厂校色', '支架可升降'],
    forWho: '要一块便宜的 4K 屏办公或修图',
  },

  /* ===== 台式机 ===== */
  {
    id: 'desktop-mac-mini-m4', category: 'desktop', sub: 'mini', brand: '苹果', name: 'Mac mini M4',
    price: 4499, commissionRate: 0.005,
    specs: { cpu: 'Apple M4', gpu: '10 核 GPU', ram: '16GB', storage: '256GB SSD',
             ports: '雷雳 4 ×3 / HDMI / 千兆网口', size: '12.7 × 12.7 × 3.5cm' },
    tags: ['比上代小很多', '静音', '存储加价贵'],
    forWho: '桌面空间小、认 macOS 的桌面用户',
  },
  {
    id: 'desktop-serm8', category: 'desktop', sub: 'mini', brand: '零刻', name: '零刻 SER8 迷你主机',
    price: 2999, commissionRate: 0.02,
    specs: { cpu: '锐龙 R7-8845HS', gpu: 'Radeon 780M 核显', ram: '32GB', storage: '1TB SSD',
             ports: 'USB4 / HDMI / 2.5G 网口', size: '135 × 135 × 45mm' },
    tags: ['32GB 起步', '接口齐全', '不占桌面'],
    forWho: '办公加轻度剪辑，要一台小主机',
  },
  {
    id: 'desktop-legion-7000k', category: 'desktop', sub: 'tower', brand: '联想', name: '拯救者 刃 7000K',
    price: 7499, commissionRate: 0.02,
    specs: { cpu: '酷睿 i5-14400F', gpu: 'RTX 4060 Ti', ram: '16GB', storage: '1TB SSD',
             ports: '前置 USB-C / 后置 HDMI + DP', size: '中塔 26L' },
    tags: ['一线品牌售后', '可自行加硬盘', '风扇声音一般'],
    forWho: '要整机、不想自己装机的游戏用户',
  },

  /* ===== 智能穿戴 ===== */
  {
    id: 'wearable-watch-gt5', category: 'wearable', sub: 'watch', brand: '华为', name: '华为 WATCH GT 5',
    price: 1488, commissionRate: 0.03,
    specs: { screen: '1.43" AMOLED', battery: '约 14 天', sensors: '心率、血氧、睡眠',
             weight: '约 51g', water: '5ATM' },
    tags: ['续航长', '健康监测全', '非鸿蒙手机也能用'],
    forWho: '主要看时间、心率、睡眠，懒得每天充电',
  },
  {
    id: 'wearable-watch-se', category: 'wearable', sub: 'watch', brand: '苹果', name: 'Apple Watch SE',
    price: 1999, commissionRate: 0.005,
    specs: { screen: '40mm 视网膜', battery: '约 18 小时', sensors: '心率、跌倒检测',
             weight: '约 30g', water: '50 米防水' },
    tags: ['苹果生态', '一天一充', '入门款'],
    forWho: '用 iPhone，想接消息、记运动',
  },
  {
    id: 'wearable-band-10', category: 'wearable', sub: 'band', brand: '小米', name: '小米手环 10',
    price: 269, commissionRate: 0.04,
    specs: { screen: '1.72" AMOLED', battery: '约 21 天', sensors: '心率、血氧、睡眠',
             weight: '约 16g', water: '5ATM' },
    tags: ['便宜', '轻', '续航三周'],
    forWho: '只想记步数、看消息、盯睡眠',
  },
  {
    id: 'wearable-glasses-air2', category: 'wearable', sub: 'glasses', brand: 'XREAL', name: 'XREAL Air 2',
    price: 2499, commissionRate: 0.02,
    specs: { screen: '双 MicroOLED 1080P', battery: '无常驻电池，连手机供电',
             sensors: '3DoF 陀螺仪', weight: '约 72g', water: '不防水' },
    tags: ['等效大屏', '躺着看片', '戴久了会热'],
    forWho: '想要随身影院、或者外接笔记本多一块屏',
  },

  /* ===== 相机 ===== */
  {
    id: 'camera-zve10-ii', category: 'camera', sub: 'mirrorless', brand: '索尼', name: '索尼 ZV-E10 II',
    price: 6799, commissionRate: 0.02,
    specs: { sensor: 'APS-C 26MP', video: '4K 60p', mount: 'E 卡口可换镜头',
             screen: '侧翻触控屏', weight: '约 377g' },
    tags: ['为视频设计', '镜头群便宜', '没有机身防抖'],
    forWho: '拍 vlog、想换镜头的入门视频用户',
  },
  {
    id: 'camera-action5-pro', category: 'camera', sub: 'action', brand: '大疆', name: '大疆 Osmo Action 5 Pro',
    price: 2598, commissionRate: 0.02,
    specs: { sensor: '1/1.3" 40MP', video: '4K 120p', mount: '磁吸快拆',
             screen: '前后双彩屏', weight: '约 146g' },
    tags: ['裸机防水', '防抖强', '骑行滑雪常用'],
    forWho: '运动、旅行、水下拍摄',
  },
  {
    id: 'camera-eos-200d2', category: 'camera', sub: 'dslr', brand: '佳能', name: '佳能 EOS 200D II',
    price: 3999, commissionRate: 0.02,
    specs: { sensor: 'APS-C 24MP', video: '4K 25p', mount: 'EF 卡口可换镜头',
             screen: '侧翻触控屏', weight: '约 449g' },
    tags: ['入门单反', '光学取景', '镜头群便宜'],
    forWho: '想从单反入门、预算四千以内',
  },
  {
    id: 'camera-g7x3', category: 'camera', sub: 'compact', brand: '佳能', name: '佳能 PowerShot G7 X Mark III',
    price: 5299, commissionRate: 0.015,
    specs: { sensor: '1 英寸 20MP', video: '4K 30p', mount: '不可换镜头 24-100mm',
             screen: '上翻触控屏', weight: '约 304g' },
    tags: ['能塞进口袋', '直播友好', '二手价高'],
    forWho: '要随身带、能拍人像和直播的卡片机',
  },

  /* ===== 镜头 ===== */
  {
    id: 'lens-sigma-1850', category: 'lens', sub: 'zoom', brand: '适马', name: '适马 18-50mm F2.8 DC DN',
    price: 2899, commissionRate: 0.02,
    specs: { mount: '索尼 E / 富士 X', range: '18-50mm（等效 27-75mm）', aperture: '恒定 F2.8',
             filter: '55mm', weight: '约 290g' },
    tags: ['挂机头常青款', '恒定大光圈', '轻'],
    forWho: '微单只配一支镜头，想拍人像和室内',
  },
  {
    id: 'lens-sony-50f18', category: 'lens', sub: 'prime', brand: '索尼', name: '索尼 FE 50mm F1.8',
    price: 1799, commissionRate: 0.02,
    specs: { mount: '索尼 E（全画幅）', range: '50mm', aperture: 'F1.8',
             filter: '49mm', weight: '约 186g' },
    tags: ['便宜的全画幅标头', '虚化够用', '对焦偏慢'],
    forWho: '第一支大光圈定焦，拍人像和日常',
  },

  /* ===== 台式机：DIY 装机 ===== */
  {
    id: 'desktop-diy-14600kf', category: 'desktop', sub: 'diy', brand: '自组', name: 'DIY 装机单：i5-14600KF + RTX 4070',
    price: 9499, commissionRate: 0,
    specs: { cpu: '酷睿 i5-14600KF', gpu: 'RTX 4070', ram: '32GB DDR5', storage: '1TB SSD',
             ports: '主板自带 + 前置 Type-C', size: '中塔 30L' },
    tags: ['同预算性能更强', '要自己动手', '以后好升级'],
    forWho: '愿意自己装、想把钱都花在性能上',
  },

  /* ===== 配件：存储 ===== */
  {
    id: 'acc-sandisk-usb-c', category: 'accessory', sub: 'storage', brand: '闪迪', name: '闪迪至尊高速 USB-C 闪存盘 256GB',
    price: 199, commissionRate: 0.05,
    specs: { type: 'U 盘', power: '无需供电', interface: 'USB-C 3.2', weight: '约 9g' },
    tags: ['手机电脑两用', '读速 400MB/s', '金属外壳'],
    forWho: '手机和电脑之间倒文件',
  },
];

/* ------------------------------------------------------------
 * 展示辅助 —— 产品页路径与展示名
 * ------------------------------------------------------------
 * build.mjs（生成静态页）和 app.js（浏览器里渲染）共用这两个函数，
 * 避免「路径规则写两遍、改一处漏一处」的老问题。
 * 不要改成 ES module：data.js 要能直接双击打开跑起来。
 * ---------------------------------------------------------- */

/** 产品页路径（不带开头的 /）：phone/redmi-k80/ */
function productPath(p) {
  const slug = String(p.id).replace(/^[a-z]+-/, '');
  return `${p.category}/${slug}/`;
}

/** 展示用全名：名字里没有品牌时才补（MacBook Air 13 M4 → 苹果 MacBook Air 13 M4） */
function displayName(p) {
  const name = String(p.name || '').trim();
  const brand = String(p.brand || '').trim();
  if (!brand || name.includes(brand)) return name;
  return `${brand} ${name}`;
}

/** 子类显示名：wearable + watch → 智能手表；没有细分时返回空串 */
function subName(catId, subId) {
  const cat = CATEGORIES.find((c) => c.id === catId);
  const sub = cat && cat.subs ? cat.subs.find((s) => s.id === subId) : null;
  return sub ? sub.name : '';
}

/* ------------------------------------------------------------
 * 价格层
 * ------------------------------------------------------------
 * 刻意做成异步接口（返回 Promise），这样它现在是「本地演示」，
 * 以后换成联盟 API 时**调用方一行都不用改**。
 *
 * 接真实价格的步骤见 README.md，核心只有一句话：
 *   把 fetchLivePrice 的实现换成对你的边缘函数发一次请求。
 * ---------------------------------------------------------- */

/* 演示模式：价格直接从产品库读，并标上 source。 */
function fetchDemoPrice(product) {
  return Promise.resolve({
    ok: true,
    source: 'demo',
    price: product.price,
    commissionRate: product.commissionRate,
    /* 联盟会给你一个带 pid 的推广链接。演示模式没有，置空。 */
    buyUrl: null,
    note: '演示数据（非实时报价）',
  });
}

/* 第二层价格（用户按需实时）：部署好边缘函数后把它改成 '/api/price'。
 * 留空 = 用第一层（构建时写进静态页的价格），此时不发任何请求。 */
const PRICE_API = '';

/**
 * 统一的取价入口。
 * 第一层：构建时已经把参考价写进 HTML，页面打开就有价格。
 * 第二层（可选）：PRICE_API 打开后，页面会去边缘函数取一次当前价，
 *   由边缘函数带着 AppKey 调联盟接口 —— 密钥不进前端，也不越过缓存规则。
 *   取不到就安静回退到静态参考价，页面不会因此空掉。
 *
 * @param {object} product 产品对象
 * @returns {Promise<{ok:boolean, source:string, price:number,
 *                    commissionRate:number, buyUrl:string|null, note?:string}>}
 */
async function fetchLivePrice(product) {
  if (!PRICE_API) return fetchDemoPrice(product);

  try {
    const r = await fetch(`${PRICE_API}?id=${encodeURIComponent(product.id)}`, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data || data.ok !== true || typeof data.price !== 'number') {
      throw new Error((data && data.error) || '返回格式不对');
    }
    return {
      ok: true,
      source: data.source || 'api',
      price: data.price,
      commissionRate: data.commissionRate ?? product.commissionRate ?? 0,
      buyUrl: data.buyUrl || null,
      note: data.note || '',
    };
  } catch (err) {
    console.warn('[digivue] 实时取价失败，用页面上的参考价：', product.id, err.message);
    return fetchDemoPrice(product);
  }
}

/* ============================================================
 * 数据自检
 * ------------------------------------------------------------
 * 加产品时最容易犯的错，是品类和参数对不上（比如给笔记本写了 battery
 * 但字段名是 battry），结果页面上那一格静默空掉、很难发现。
 * 这里在启动时把它喊出来。
 *
 * 只在控制台输出，不阻塞页面。
 * ============================================================ */
(function checkData() {
  const problems = [];
  const catIds = new Set(CATEGORIES.map((c) => c.id));
  const seenIds = new Set();

  if (!Array.isArray(PRODUCTS) || PRODUCTS.length === 0) {
    console.error('[digipick] 数据自检：PRODUCTS 为空或不是数组');
    return;
  }

  for (const p of PRODUCTS) {
    const who = p && p.id ? p.id : '(缺少 id)';

    if (!p.id) problems.push(`${who}：缺少 id`);
    else if (seenIds.has(p.id)) problems.push(`${who}：id 重复`);
    else seenIds.add(p.id);

    if (!p.name) problems.push(`${who}：缺少 name`);
    if (!p.brand) problems.push(`${who}：缺少 brand`);

    if (!catIds.has(p.category)) {
      problems.push(`${who}：category "${p.category}" 不在 CATEGORIES 里`);
      continue; /* 品类都不认识，下面的参数检查没意义 */
    }

    /* 细分：大类有 subs 时产品必须写对 sub，没有 subs 时不该写 */
    const cat = CATEGORIES.find((c) => c.id === p.category);
    const subs = cat && cat.subs ? cat.subs : [];
    if (subs.length) {
      if (!p.sub) {
        problems.push(`${who}：${cat.name} 有细分，必须写 sub（可选：${subs.map((s) => s.id).join(', ')}）`);
      } else if (!subs.some((s) => s.id === p.sub)) {
        problems.push(`${who}：sub "${p.sub}" 不在 ${cat.name} 的细分里（可用：${subs.map((s) => s.id).join(', ')}）`);
      }
    } else if (p.sub) {
      problems.push(`${who}：${cat.name} 没有再细分，不该写 sub "${p.sub}"`);
    }

    if (typeof p.price !== 'number' || !(p.price > 0)) {
      problems.push(`${who}：price 必须是正数，现在是 ${JSON.stringify(p.price)}`);
    }

    const fields = SPEC_FIELDS[p.category] || [];
    const specs = p.specs || {};
    const missing = fields.filter((f) => {
      const v = specs[f.key];
      return v === undefined || v === null || v === '';
    }).map((f) => f.key);

    if (missing.length) {
      problems.push(
        `${who}（${p.category}）：缺少参数 ${missing.join(', ')}` +
        `（可用字段：${fields.map((f) => f.key).join(', ')}）`
      );
    }

    /* 反向检查：写了但没人展示的字段，通常是拼错了 */
    const known = new Set(fields.map((f) => f.key));
    const orphan = Object.keys(specs).filter((k) => !known.has(k));
    if (orphan.length) {
      problems.push(`${who}：参数 ${orphan.join(', ')} 不在 ${p.category} 的展示字段里（拼错了？）`);
    }

    if (typeof p.commissionRate !== 'number' || p.commissionRate < 0) {
      problems.push(`${who}：commissionRate 必须是非负数`);
    }

    /* 渠道货：格式不对的话，取价脚本会拿错误的 SKU 去查接口 */
    if (p.offers !== undefined) {
      if (!Array.isArray(p.offers)) {
        problems.push(`${who}：offers 必须是数组`);
      } else {
        p.offers.forEach((o, i) => {
          if (!o || typeof o !== 'object') { problems.push(`${who}：offers[${i}] 不是对象`); return; }
          if (!['jd', 'tb', 'pdd'].includes(o.platform)) {
            problems.push(`${who}：offers[${i}].platform 必须是 jd / tb / pdd，现在是 ${JSON.stringify(o.platform)}`);
          }
          if (!o.sku && !o.itemId) {
            problems.push(`${who}：offers[${i}] 缺少 sku（京东）或 itemId（淘宝）`);
          }
        });
      }
    }
  }

  if (problems.length) {
    console.warn(
      `[digipick] 数据自检发现 ${problems.length} 个问题：\n  - ` + problems.join('\n  - ')
    );
  } else {
    const bound = PRODUCTS.filter((p) => (p.offers || []).length).length;
    console.log(
      `[digipick] 数据自检通过：${PRODUCTS.length} 款产品，${CATEGORIES.length} 个品类` +
      (bound ? `，其中 ${bound} 款已绑定渠道 SKU` : '，都还没绑定渠道 SKU（价格用参考价）')
    );
  }
})();
