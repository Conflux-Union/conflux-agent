export interface ExplorationAcknowledgementClient {
  addEyesReaction(owner: string, repo: string, number: number): Promise<void>;
}

export async function acknowledgeAndExplore<T>(
  github: ExplorationAcknowledgementClient,
  target: { owner: string; repo: string; number: number },
  explore: () => Promise<T>,
): Promise<T> {
  await github.addEyesReaction(target.owner, target.repo, target.number);
  return explore();
}
