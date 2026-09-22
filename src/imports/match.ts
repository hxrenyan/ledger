/**
 * 分类 / 账户的建议匹配。
 *
 * 只给「建议」不做强绑定：预览页用户可改，提交时仍按 id 校验归属与类型。
 * 策略：名称直接命中 → 关键词表命中 → 同方向第一个分类 / 第一个账户兜底。
 */

export type CategoryLite = { id: string; name: string; kind: 'expense' | 'income' }
export type AccountLite = { id: string; name: string }
export type Suggestion = { id: string; name: string }

const EXPENSE_KEYWORDS: { category: string; words: string[] }[] = [
  { category: '餐饮', words: ['餐', '饭', '外卖', '美团', '饿了么', '肯德基', '麦当劳', '星巴克', '瑞幸', '咖啡', '奶茶', '烧烤', '火锅', '小吃', '食堂', '面馆', '酒楼', '餐厅', '烘焙', '水果', '菜市场', '生鲜'] },
  { category: '交通', words: ['地铁', '公交', '出租', '滴滴', '花小猪', '打车', '高铁', '火车', '机票', '航空', '加油', '停车', 'etc', '单车', '哈啰', '青桔', '美团单车', '过路费', '车费', '顺风车', '充电桩'] },
  { category: '购物', words: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '超市', '便利店', '商场', '购物', '服饰', '优衣库', '数码', '小米', '华为', '苹果', '抖音商城', '苏宁', '百货', '无印良品', '名创优品'] },
  { category: '房租', words: ['房租', '租金', '物业费', '中介费', '房东'] },
  { category: '水电', words: ['水费', '电费', '燃气', '话费', '宽带', '流量', '充值', '移动', '联通', '电信', '取暖', '供暖', '物业', '垃圾费'] },
  { category: '娱乐', words: ['电影', '游戏', '演出', '演唱会', 'ktv', '会员', '爱奇艺', '腾讯视频', '优酷', '网易云', '音乐', '健身', '旅游', '门票', '酒店', '民宿', 'steam', 'b站'] },
  { category: '医疗', words: ['医院', '药', '药店', '诊所', '挂号', '体检', '医保', '牙科', '眼科', '医疗'] },
  { category: '教育', words: ['学费', '培训', '课程', '书', '书店', '教育', '考试', '文具', '网校'] },
]

const INCOME_KEYWORDS: { category: string; words: string[] }[] = [
  { category: '工资', words: ['工资', '薪资', '薪酬', '薪水', '代发工资', '月薪'] },
  { category: '奖金', words: ['奖金', '年终奖', '绩效', '提成', '奖励'] },
  { category: '兼职', words: ['兼职', '副业', '稿费', '劳务', '外快', '接单'] },
  { category: '红包', words: ['红包', '压岁钱', '礼金', '返现', '返利'] },
]

const ACCOUNT_KEYWORDS: { account: string; words: string[] }[] = [
  { account: '支付宝', words: ['支付宝', '花呗', '余额宝', '蚂蚁'] },
  { account: '微信', words: ['微信', '零钱', '财付通'] },
  { account: '现金', words: ['现金', '现钞'] },
  { account: '银行卡', words: ['银行', '借记卡', '储蓄卡', '信用卡', '银联', '招行', '工商', '建设', '农业', '交通银行', '邮储', '民生', '兴业', '浦发', '中信', '光大', '平安', '广发', '华夏', '北京银行', '招商'] },
]

function findByName(list: { id: string; name: string }[], needle: string): Suggestion | null {
  const key = needle.trim().toLowerCase()
  if (!key) return null
  const exact = list.find((c) => c.name.toLowerCase() === key)
  if (exact) return { id: exact.id, name: exact.name }
  const partial = list.find((c) => c.name && (c.name.includes(needle) || needle.includes(c.name)))
  return partial ? { id: partial.id, name: partial.name } : null
}

/** 文本（备注 / 商品 / 对方 / 分类列）→ 建议分类。 */
export function suggestCategory(direction: 'expense' | 'income', text: string, categories: CategoryLite[]): Suggestion | null {
  const pool = categories.filter((c) => c.kind === direction)
  if (!pool.length) return null
  const hay = text.toLowerCase()

  // 1. 文本里直接出现现有分类名（取名字最长的，避免「其他」之类过短误命中）
  const byName = [...pool]
    .filter((c) => c.name.length >= 2 && hay.includes(c.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (byName) return { id: byName.id, name: byName.name }

  // 2. 关键词表 → 目标分类名 → 现有分类
  const table = direction === 'expense' ? EXPENSE_KEYWORDS : INCOME_KEYWORDS
  for (const { category, words } of table) {
    if (!words.some((w) => hay.includes(w))) continue
    const hit = findByName(pool, category)
    if (hit) return hit
  }

  // 3. 兜底：同方向第一个分类（通常是用户排序后的首选）
  const fallback = pool[0]
  return fallback ? { id: fallback.id, name: fallback.name } : null
}

/** 文本（支付方式 / 付款方式 / 账户列）→ 建议账户。 */
export function suggestAccount(text: string, accounts: AccountLite[]): Suggestion | null {
  if (!accounts.length) return null
  const hay = text.toLowerCase()
  const byName = [...accounts]
    .filter((a) => a.name.length >= 2 && hay.includes(a.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (byName) return { id: byName.id, name: byName.name }

  for (const { account, words } of ACCOUNT_KEYWORDS) {
    if (!words.some((w) => hay.includes(w))) continue
    const hit = findByName(accounts, account)
    if (hit) return hit
  }
  return null
}

/** 账单来源推断默认账户（微信账单 → 微信；支付宝账单 → 支付宝）。 */
export function accountNameBySource(source: string): string {
  if (source === 'wechat') return '微信'
  if (source === 'alipay') return '支付宝'
  return ''
}
