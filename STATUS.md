# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | **모노레포 3-레이어 구조 재편 완료 (dmz/ + internal/ + blockchain/)** |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 50시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-04-26)
- M2_S5 강의노트 완전 재작성: ChainEventListener 전체 흐름, 사용자+설계자 관점 이중 구조, 실습 1 포함
- NFTIssuer.sol: event Issued 추가, issueActivityNFT() 신규 함수 추가, emit 연결
- 스켈레톤 코드 불일치 수정: NFT_CONTRACT_ADDR → KYOBO_NFT_PROXY_ADDR 전체 치환
- M1 강의노트(M1_architecture_setup.md) 업데이트

## 다음 작업
- [ ] M2_S6 강의노트 작성: ChainEventListener 내부구조 + Missed Event 복구 + NFTIssuedHandler
- [ ] M1 S1 공부하며 내용 보완
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS와 Core Banking API 스펙 협의
