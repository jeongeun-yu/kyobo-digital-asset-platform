import type { ChainEvent } from '@kyobo/chain-adapters';

/**
 * IEventHandler — 온체인 이벤트 처리기 인터페이스
 *
 * 각 이벤트 종류마다 구현체를 하나씩 만든다.
 * ChainEventListener는 이 인터페이스만 알고, 어떤 이벤트가 어떤 시스템을 건드리는지 모른다.
 * Phase 2/3에서 새 이벤트가 추가되면 핸들러만 추가하고 리스너는 건드리지 않는다.
 */
export interface IEventHandler {
  /** 이 핸들러가 처리할 이벤트 이름 */
  readonly eventName: string;

  /** 컨트랙트 주소 (빈 문자열이면 전체) */
  readonly contractAddr: string;

  /**
   * 이벤트 처리
   * 멱등성 보장 필수 — 동일 txHash + logIndex로 두 번 호출돼도 결과 동일해야 함
   */
  handle(event: ChainEvent): Promise<void>;
}
