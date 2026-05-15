/**
 * EventType — 이벤트 파이프라인 전 구간 공통 이벤트 타입 상수
 *
 * VASP → Webhook → Redis Streams → ConsumerGroupWorker → EventProcessor
 * 전 구간에서 동일한 상수를 참조해 문자열 오타를 컴파일 타임에 차단.
 *
 * 새 이벤트 추가 시:
 *   1. 이 파일에 상수 추가
 *   2. 해당 EventProcessor 구현체 추가 (eventTypes 배열에서 참조)
 *   3. 발행 쪽(Handler)에서 동일 상수 참조
 */

// ── 온체인 이벤트 ─────────────────────────────────────────────────────────
// 블록체인 → ChainEventListener → NFTIssuedHandler → Redis Streams

export const EventType = {
  /** NFT 발행 완료 (스마트 컨트랙트 Transfer 이벤트) */
  NFT_ISSUED:      'NFT_ISSUED',
  /** NFT 소각 완료 */
  NFT_BURNED:      'NFT_BURNED',
  /** NFT P2P 전송 완료 */
  NFT_TRANSFERRED: 'NFT_TRANSFERRED',

  // ── 활동 기반 이벤트 ────────────────────────────────────────────────────
  // VASP → Webhook → Redis Streams → EventConditionService

  /** 활동 달성 통합 이벤트 (걷기·건강검진 등) */
  ACTIVITY_ACHIEVED:  'ACTIVITY_ACHIEVED',
  /** 걷기 목표 달성 */
  WALK_GOAL_MET:      'WALK_GOAL_MET',
  /** 건강검진 완료 */
  HEALTH_CHECK_DONE:  'HEALTH_CHECK_DONE',
  /** 쿠폰 사용 */
  COUPON_CLAIM:       'COUPON_CLAIM',
  /** 캠페인 리워드 지급 */
  CAMPAIGN_REWARD:    'CAMPAIGN_REWARD',
} as const;

export type EventType = typeof EventType[keyof typeof EventType];
