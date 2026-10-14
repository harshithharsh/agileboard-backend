// Which role a piece of work sits with, judged from its Jira status name.
// Matches this Jira's workflow (e.g. "Development Inprogress", "Delivered to QA", "FAILED TEST",
// "Delivered to UAT") and common names elsewhere. Order matters: the first rule that matches wins.
const RULES = [
  ['Developer', /fail|reopen|rework|reject/i], // a failed test goes back to development
  ['BA', /uat|acceptance|requirement|analysis|refine|groom|clarif|design/i],
  ['QA', /qa|test|verif/i],
  ['Developer', /develop|progress|review|code|implement|selected/i],
  ['BA', /^(to do|todo|backlog|open|new)$/i],
];

export function stageOf(statusName) {
  if (!statusName) return 'Unknown';
  return RULES.find(([, re]) => re.test(statusName))?.[0] ?? 'Other';
}

export const STAGES = ['Developer', 'QA', 'BA', 'Other', 'Unknown'];
