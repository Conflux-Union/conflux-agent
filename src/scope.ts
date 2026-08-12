const EXPLICIT_OFF_TOPIC_PATTERNS = [
  /(?:讲|说|来|编)(?:一个|个|段|一下)?[^\n]{0,8}(?:冷笑话|笑话|段子)/u,
  /(?:冷笑话|陪我聊天|陪我闲聊|闲聊一下)/u,
  /\b(?:tell|give)\s+(?:me\s+)?(?:a\s+)?(?:joke|funny story)\b/i,
  /\b(?:let'?s|wanna)\s+(?:chat|role[ -]?play)\b/i,
];

const REPOSITORY_WORK_PATTERN =
  /(?:代码|仓库|崩溃|报错|复现|修复|功能|测试|构建|发布|版本|模块|接口|文档|性能|安全|兼容|\b(?:code|repo|issue|bug|pr|pull request|crash|error|test|build|release|version|module|api|docs?|performance|security)\b)/iu;

export function isClearlyOffTopicRequest(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 &&
    !REPOSITORY_WORK_PATTERN.test(normalized) &&
    EXPLICIT_OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function offTopicReply(text: string): string {
  return /\p{Script=Han}/u.test(text)
    ? "这里只处理与本仓库代码、Issue、PR、复现、设计和维护有关的内容。这个请求与仓库工作无关，我不会执行。"
    : "I only handle work related to this repository's code, issues, pull requests, reproduction, design, and maintenance. I won't fulfill unrelated requests.";
}
