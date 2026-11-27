import { invalidResponse, isDay } from './public-provider.mjs'

const accounts = {
  revenue: ['IS', ['ifrs-full_Revenue', 'ifrs_Revenue'], ['매출액', '영업수익']],
  operatingIncome: ['IS', ['dart_OperatingIncomeLoss'], ['영업이익', '영업이익(손실)', '영업손익']],
  netIncome: ['IS', ['ifrs-full_ProfitLoss', 'ifrs_ProfitLoss'], ['당기순이익', '당기순이익(손실)', '당기순손익', '분기순이익', '반기순이익']],
  parentNetIncome: ['IS', ['ifrs-full_ProfitLossAttributableToOwnersOfParent', 'ifrs_ProfitLossAttributableToOwnersOfParent'],
    ['지배기업 소유주 귀속 당기순이익', '지배기업의 소유주에게 귀속되는 당기순이익', '지배기업의 소유주에게 귀속되는 당기순이익(손실)']],
  assets: ['BS', ['ifrs-full_Assets', 'ifrs_Assets'], ['자산총계']],
  liabilities: ['BS', ['ifrs-full_Liabilities', 'ifrs_Liabilities'], ['부채총계']],
  equity: ['BS', ['ifrs-full_Equity', 'ifrs_Equity'], ['자본총계']],
  parentEquity: ['BS', ['ifrs-full_EquityAttributableToOwnersOfParent', 'ifrs_EquityAttributableToOwnersOfParent'],
    ['지배기업 소유주지분', '지배기업 소유주 귀속 자본', '지배기업의 소유주에게 귀속되는 자본']],
  openingParentEquity: ['SCE', ['dart_EquityAtBeginningOfPeriod'], ['기초자본', '기초 자본']],
  operatingCashFlow: ['CF', ['ifrs-full_CashFlowsFromUsedInOperatingActivities', 'ifrs_CashFlowsFromUsedInOperatingActivities'],
    ['영업활동현금흐름', '영업활동으로 인한 현금흐름']],
  propertyPlantEquipmentAcquisitions: ['CF', ['ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
    'ifrs_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'], ['유형자산의 취득', '유형자산 취득']],
  intangibleAcquisitions: ['CF', ['ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities',
    'ifrs_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities'], ['무형자산의 취득', '무형자산 취득']],
}

const standardIds = new Set(Object.values(accounts).flatMap(([, ids]) => ids))
const compact = text => text.replace(/\s+/g, '')
const parentMember = '자본[member]|지배기업소유주지분'
const missing = reason => ({ value: null, status: reason === 'not-provided' ? 'missing' : 'invalid', reason })

function amount(raw) {
  if (raw == null || (typeof raw === 'string' && ['', '-'].includes(raw.trim()))) return missing('not-provided')
  if (typeof raw !== 'string' || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw.trim()))
    return missing('invalid-amount')
  return { value: raw.trim().replaceAll(',', '').replace(/^\+/, ''), status: 'reported', reason: null }
}

function periodAmounts(row, period) {
  if (row.sj_div === 'BS') return { basis: 'point-in-time', current: amount(row.thstrm_amount), previous: amount(row.frmtrm_amount) }
  if (period === 'annual') return { basis: 'annual', current: amount(row.thstrm_amount), previous: amount(row.frmtrm_amount) }
  const income = ['IS', 'CIS'].includes(row.sj_div)
  const comparable = row.sj_div !== 'SCE'
  const useFallback = !income || period === 'q1'
  const accumulated = (primary, fallback) => {
    const result = amount(primary)
    return result.status === 'missing' && useFallback ? amount(fallback) : result
  }
  return {
    basis: 'year-to-date',
    current: accumulated(row.thstrm_add_amount, row.thstrm_amount),
    previous: comparable
      ? accumulated(row.frmtrm_add_amount, row.frmtrm_q_amount)
      : missing('period-not-comparable'),
    ...(income && { reportedQuarter: { current: amount(row.thstrm_amount), previous: amount(row.frmtrm_q_amount) } }),
  }
}

function classify(row, [statement, ids, aliases]) {
  if (row.sj_div !== statement && !(statement === 'IS' && row.sj_div === 'CIS')) return 0
  const detail = compact(row.account_detail ?? '')
  if (statement === 'SCE' ? detail !== parentMember : detail && detail !== '-') return 0
  const sectionRank = row.sj_div === 'CIS' ? 0 : 1
  if (ids.includes(row.account_id)) return 4 + sectionRank
  if (standardIds.has(row.account_id) || /^ifrs(?:-full)?_/.test(row.account_id)) return 0
  return aliases.some(alias => compact(alias) === compact(row.account_nm)) ? 2 + sectionRank : 0
}

function normalizedAccount(id, rule, rows, period, scope) {
  const basis = rule[0] === 'BS' ? 'point-in-time'
    : rule[0] === 'SCE' ? 'opening-balance' : period === 'annual' ? 'annual' : 'year-to-date'
  const empty = { id, statement: rule[0], basis, original: null, mapping: null, currency: null, unit: null }
  const unavailable = reason => ({ ...empty, quality: reason === 'not-provided' ? 'missing' : 'invalid',
    reason, current: missing(reason), previous: missing(reason) })
  if (scope === 'OFS' && ['parentNetIncome', 'parentEquity', 'openingParentEquity'].includes(id))
    return unavailable('scope-not-applicable')
  let rank = 0
  let candidates = []
  for (const row of rows) {
    const scored = classify(row, rule)
    if (!scored || scored < rank) continue
    if (scored > rank) candidates = []
    rank = scored
    const values = periodAmounts(row, period)
    if (rule[0] === 'SCE') values.basis = 'opening-balance'
    const currency = typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null
    candidates.push({ id, statement: row.sj_div, ...values, currency, unit: currency ? 'currency-unit' : null,
      original: { accountId: row.account_id || null, name: row.account_nm, detail: row.account_detail || null },
      mapping: rank >= 4 ? 'standard-id' : 'exact-alias' })
  }
  if (!candidates.length) return unavailable('not-provided')
  const [first] = candidates
  const fields = ({ currency, current, previous, reportedQuarter }) => JSON.stringify([currency, current, previous, reportedQuarter])
  if (candidates.some(candidate => fields(candidate) !== fields(first))) return unavailable('conflicting-accounts')
  const reason = !first.currency ? 'currency-not-provided' : first.current.reason
  return { ...first, quality: reason === null ? 'reported' : reason === 'not-provided' ? 'missing' : 'invalid', reason }
}

export function normalizeDartAccounts(rows, { corpCode, year, period, reportCode, scope }) {
  let receipt
  const receipts = new Set()
  let current = []
  for (const row of rows) {
    if (row?.corp_code !== corpCode || row.bsns_year !== year || row.reprt_code !== reportCode ||
        (row.fs_div != null && row.fs_div !== scope) || typeof row.rcept_no !== 'string' || !/^\d{14}$/.test(row.rcept_no) ||
        !['IS', 'CIS', 'BS', 'CF', 'SCE'].includes(row.sj_div) || typeof row.account_nm !== 'string' ||
        (row.account_id != null && typeof row.account_id !== 'string') ||
        (row.account_detail != null && typeof row.account_detail !== 'string')) throw invalidResponse()
    // Compare complete report versions. Older receipts cannot fill gaps in the newest filing.
    receipts.add(row.rcept_no)
    if (receipt === undefined || row.rcept_no > receipt) {
      receipt = row.rcept_no
      current = []
    }
    if (row.rcept_no === receipt) current.push(row)
  }
  const normalized = Object.entries(accounts).map(([id, rule]) => normalizedAccount(id, rule, current, period, scope))
  const parentEquity = normalized.find(account => account.id === 'parentEquity')
  return { receipt, accounts: [...normalized, { ...parentEquity, id: 'closingParentEquity', sameBalanceAs: 'parentEquity' }],
    rowCount: current.length, earlierReceipts: [...receipts].filter(id => id !== receipt).sort() }
}

export function dartFiscalEnd(rows, { receipt, stockCode, year, reportCode, scope }) {
  const dates = new Set(rows.flatMap(row => {
    if (row?.rcept_no !== receipt || row.stock_code !== stockCode || row.bsns_year !== year ||
        row.reprt_code !== reportCode || row.fs_div !== scope || row.sj_div !== 'BS' || typeof row.thstrm_dt !== 'string') return []
    const date = /^\s*(\d{4}[.-]\d{2}[.-]\d{2})(?:\s*현재)?\s*$/.exec(row.thstrm_dt)?.[1].replaceAll('.', '-')
    return isDay(date) ? [date] : []
  }))
  return dates.size === 1 ? [...dates][0] : null
}
