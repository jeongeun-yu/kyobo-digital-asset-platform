# TypeScript 워밍업
## Java 백엔드 개발자를 위한 60분 압축 가이드

> **대상**: Java/JS는 알지만 TypeScript는 거의 처음인 분
> **목표**: 이후 50시간 커리큘럼의 코드를 *읽고*, *쓰고*, *디버깅*할 수 있는 최소 수준
> **소요**: 60분 강의 + 자율 복습용 참고 자료

---

## 시작하기 전에 — TypeScript는 무엇인가

**한 줄로**: JavaScript에 *타입 시스템*을 얹은 언어. 컴파일 시점에 타입을 검사해서 런타임 버그를 미리 잡는다.

```
[TypeScript 소스 (.ts)]
         ↓ tsc 컴파일러
[JavaScript (.js)] ← 실제 실행되는 것
         ↓ Node.js
[실행 결과]
```

**Java 개발자가 가장 먼저 알아야 할 것**: TypeScript의 타입은 *컴파일 타임에만* 존재한다. 실행 시점에는 타입 정보가 사라지고 그냥 JavaScript가 돈다.

```typescript
// 컴파일 시 검사: OK
const userId: string = "user-001";

// 실행 시: const userId = "user-001"; ← 그냥 JS
```

이게 Java와의 결정적 차이다. Java는 런타임에도 타입이 살아있다(`getClass()`, `instanceof`). TypeScript는 그렇지 않다.

---

# 1. 타입 표기 기본 (5분)

## 1-1. 변수 선언

```typescript
let userId: string = "user-001";
let amount: number = 100;
let isActive: boolean = true;
let tokenIds: number[] = [1, 2, 3];
```

**문법**: `이름 : 타입 = 값`

Java와 비교:
```java
String userId = "user-001";        // Java
let userId: string = "user-001";   // TypeScript
```

순서가 반대다. Java는 *타입 → 이름*, TypeScript는 *이름 → 타입*.

## 1-2. 타입 추론 — 보통은 표기 생략

TypeScript는 똑똑해서 초기값을 보고 타입을 *자동으로 추론*한다.

```typescript
let userId = "user-001";   // string으로 자동 추론
let amount = 100;          // number로 자동 추론
```

**실무 컨벤션**: 변수 선언 시에는 *대부분 타입 표기 생략*하고 추론에 맡긴다. 명시적으로 쓰는 경우는:
- 함수 파라미터/반환값 (필수에 가까움)
- 추론이 안 되거나 의도와 다른 경우
- 인터페이스/타입 정의

## 1-3. 함수 타입 표기

```typescript
function mintToken(to: string, amount: number): boolean {
  return true;
}
```

**문법**: 파라미터마다 `: 타입`, 반환값은 `): 타입`.

화살표 함수도 동일:
```typescript
const mintToken = (to: string, amount: number): boolean => {
  return true;
};
```

## 1-4. 기본 타입 7개

| TypeScript | 의미 | Java 대응 |
|---|---|---|
| `string` | 문자열 | `String` |
| `number` | 숫자 (정수+실수) | `int`, `long`, `double` 통합 |
| `boolean` | 참/거짓 | `boolean` |
| `bigint` | 큰 정수 | `BigInteger` |
| `null` | null | `null` |
| `undefined` | 정의 안됨 | (Java에 없음) |
| `void` | 반환 없음 | `void` |

**`null` vs `undefined`** — 둘이 다르다. 
- `null`: "값이 없음을 명시적으로 표시"
- `undefined`: "값이 할당된 적 없음"

실무에서는 *둘 다 쓰임*. 보통 `null`은 의도적으로 비워둠을 표시할 때, `undefined`는 옵셔널 값이 없을 때.

## 1-5. 자주 만나는 함정

```typescript
// 함정 1: any는 쓰지 마라
let x: any = "anything";  // 모든 타입 검사 우회 — 사실상 JS로 돌아감

// 함정 2: 반환 타입 빠뜨리면 추론됨 — 안전하지만 가독성 ↓
function add(a: number, b: number) {  // 반환 타입 없음
  return a + b;  // 자동으로 number로 추론
}
// → 실무: public 함수는 반환 타입 명시 권장
```

---

# 2. interface와 type (7분)

객체 모양을 정의하는 두 가지 방법. M3~M5의 어댑터 패턴 핵심.

## 2-1. interface

```typescript
interface MintRequest {
  to: string;
  tokenId: number;
  amount: number;
}

function processMint(req: MintRequest) {
  console.log(req.to);       // OK
  console.log(req.unknown);  // 컴파일 에러
}

processMint({
  to: "0x742d...",
  tokenId: 1,
  amount: 100
});
```

**Java와 비교**:

```java
// Java
public interface MintRequest {
    String getTo();
    Long getTokenId();
    Long getAmount();
}
public class MintRequestImpl implements MintRequest { ... }
```

```typescript
// TypeScript
interface MintRequest {
  to: string;
  tokenId: number;
  amount: number;
}
// 구현체 클래스 불필요. 그냥 객체 리터럴이면 OK.
const req: MintRequest = { to: "0x...", tokenId: 1, amount: 100 };
```

**핵심 차이**: TypeScript의 interface는 *객체의 모양 검증자*다. 클래스가 implements 안 해도 모양만 맞으면 통과 — 이걸 **구조적 타이핑(structural typing)**이라고 함. Java의 명목적 타이핑(nominal typing)과 정반대.

## 2-2. 옵셔널 필드 — `?`

```typescript
interface MintRequest {
  to: string;
  tokenId: number;
  amount: number;
  metadata?: string;  // ← 있어도 되고 없어도 됨
}

processMint({ to: "0x...", tokenId: 1, amount: 100 });           // OK
processMint({ to: "0x...", tokenId: 1, amount: 100, metadata: "..." }); // OK
```

옵셔널 필드의 타입은 자동으로 `string | undefined`가 된다.

## 2-3. readonly — 불변 필드

```typescript
interface User {
  readonly id: string;     // 변경 불가
  name: string;            // 변경 가능
}

const user: User = { id: "u-1", name: "Sharon" };
user.name = "Kim";   // OK
user.id = "u-2";     // 컴파일 에러
```

Java의 `final` 필드와 비슷. Custody 컨트랙트에서 `readonly chainId: number` 같은 패턴 자주 봄.

## 2-4. 메서드 정의

```typescript
interface IBlockchainAdapter {
  readonly chainId: number;
  
  mintNFT(params: MintParams): Promise<TxResult>;
  burnNFT(params: BurnParams): Promise<TxResult>;
  getBalance(address: string, tokenId: number): Promise<bigint>;
}
```

**M3 핵심 인터페이스**가 이 모양. Phase 1에서 만나게 될 것.

## 2-5. type — interface와 비슷하지만 더 유연

```typescript
type Status = "pending" | "confirmed" | "failed";  // 유니온 타입
type UserId = string;                               // 별칭
type MintHandler = (req: MintRequest) => void;      // 함수 타입
```

**interface vs type 어떤 걸 쓰나**:

| 상황 | 권장 |
|---|---|
| 객체 모양 정의 | `interface` |
| 유니온/리터럴 타입 | `type` |
| 함수 시그니처 | `type` |
| 확장(extends) 자주 함 | `interface` |

실무 컨벤션: **객체는 interface, 그 외는 type**. 둘 다 가능한 경우엔 interface 우선.

---

# 3. 유니온 타입과 옵셔널 (5분)

## 3-1. 유니온 타입 — `|`

"이 값은 A이거나 B다"를 표현.

```typescript
let status: "pending" | "confirmed" | "failed";

status = "pending";    // OK
status = "confirmed";  // OK
status = "unknown";    // 컴파일 에러
```

**TX 상태머신에서의 사용**:

```typescript
type TxStatus = 
  | "REQUESTED"
  | "SUBMITTED"  
  | "PENDING"
  | "MINED"
  | "CONFIRMED"
  | "FINALIZED"
  | "FAILED"
  | "REORGED";

function updateStatus(txId: string, status: TxStatus) {
  // status는 위 8개 중 하나만 가능. 오타 방지!
}
```

Java의 `enum`보다 가볍게 쓸 수 있음. 단순 식별자면 enum 대신 유니온 리터럴 권장.

## 3-2. 다른 타입의 유니온

```typescript
let id: number | string;   // 숫자 또는 문자열

id = 1;       // OK
id = "u-1";   // OK
id = true;    // 에러
```

## 3-3. null 가능성 표현

```typescript
function findUser(id: string): User | null {
  // 못 찾으면 null 반환
  return null;
}

const user = findUser("u-1");
console.log(user.name);  // 컴파일 에러 — null일 수 있음

if (user !== null) {
  console.log(user.name);  // OK — 좁혀짐(narrowed)
}
```

**Java와의 차이**: Java는 모든 객체가 자동으로 nullable. TypeScript는 *명시적으로 표기*해야만 nullable. 이게 NullPointerException을 컴파일 시점에 잡아주는 핵심.

## 3-4. 옵셔널 체이닝 — `?.`

null 체크를 짧게.

```typescript
// 기존 방식
const name = user !== null ? user.name : undefined;

// 옵셔널 체이닝
const name = user?.name;  // user가 null/undefined면 undefined, 아니면 user.name
```

깊은 객체에서 진가가 나옴:

```typescript
const street = order?.user?.address?.street;
// order, user, address 중 하나라도 null이면 → undefined
// 다 있으면 → street 값
```

## 3-5. nullish 병합 — `??`

null/undefined일 때 기본값 제공.

```typescript
const name = user?.name ?? "Anonymous";
// user.name이 null/undefined면 "Anonymous", 아니면 user.name
```

`||`와의 차이가 미묘하니 주의:

```typescript
const count = userInput || 10;   // userInput이 0이면 10 (의도 다름)
const count = userInput ?? 10;   // userInput이 0이면 0, null/undefined일 때만 10
```

`||`는 falsy(`0`, `""`, `false`) 모두 포함, `??`는 *오직 null/undefined*만.

---

# 4. 제네릭 (7분)

타입을 *변수처럼* 쓰는 기능. Java의 제네릭과 거의 동일.

## 4-1. 함수 제네릭

```typescript
function wrap<T>(value: T): T[] {
  return [value];
}

const nums = wrap(10);        // T = number → number[]
const strs = wrap("hello");   // T = string → string[]
```

**Java와 비교**:

```java
// Java
public <T> List<T> wrap(T value) {
    return Arrays.asList(value);
}
```

```typescript
// TypeScript
function wrap<T>(value: T): T[] {
  return [value];
}
```

문법 거의 동일. `<T>` 위치만 다름.

## 4-2. 가장 자주 만나는 제네릭 — Promise<T>, Array<T>

```typescript
async function fetchUser(id: string): Promise<User> {
  const data = await fetch(`/users/${id}`);
  return data.json();
}

const users: Array<User> = [];   // = User[]
const ids: Array<string> = [];   // = string[]
```

Promise는 거의 모든 비동기 함수에서 쓴다. **반환 타입 `Promise<X>` = "이 함수는 비동기로 X를 돌려준다"**.

## 4-3. 제네릭 제약 — `extends`

"T는 아무 타입이 아니라, 특정 모양을 가진 타입이어야 한다"는 제약.

```typescript
interface HasId {
  id: string;
}

function findById<T extends HasId>(items: T[], id: string): T | undefined {
  return items.find(item => item.id === id);
}

const users: User[] = [...];
findById(users, "u-1");  // User는 id 필드를 가지므로 OK

const numbers = [1, 2, 3];
findById(numbers, "1");  // 에러 — number는 id 필드 없음
```

## 4-4. 제네릭 인터페이스

```typescript
interface Repository<T> {
  findById(id: string): Promise<T | null>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

class UserRepo implements Repository<User> { ... }
class NftRepo implements Repository<Nft> { ... }
```

**Java의 `Repository<T>`와 동일한 패턴**. Spring Data JPA 써본 분이면 친숙할 것.

## 4-5. 실전 — IBlockchainAdapter에서의 제네릭

```typescript
interface ITxResult<T> {
  txHash: string;
  blockNumber: number;
  data: T;
}

interface IBlockchainAdapter {
  mintNFT(params: MintParams): Promise<ITxResult<MintData>>;
  burnNFT(params: BurnParams): Promise<ITxResult<BurnData>>;
}
```

Mint와 Burn은 결과의 *공통 부분*은 같지만 *세부 데이터*가 다르다. 제네릭으로 깔끔하게 표현.

---

# 5. bigint vs number — 사고 단골 (8분)

⚠️ **이 한 섹션이 1시간 자료에서 가장 중요할 수 있어요.** 잘못 다루면 *돈이 사라집니다*.

## 5-1. JavaScript number의 한계

```typescript
const max = Number.MAX_SAFE_INTEGER;
console.log(max);  // 9007199254740991 (약 9 × 10^15)
```

JavaScript의 `number`는 **64비트 부동소수점(double)**이다. 정수 표현 가능 범위는 약 **2^53 - 1 = 9 × 10^15**까지.

## 5-2. Solidity uint256의 크기

```solidity
uint256 amount = 1000000000000000000;  // 1 ETH = 10^18 wei
```

**uint256은 최대 2^256 - 1 ≈ 1.15 × 10^77**.

비교:
- JS number 안전 범위: 9,007,199,254,740,991 (16자리)
- uint256 최대값: 약 78자리

→ **JS number로 uint256을 받으면 정밀도 손실 100% 발생**.

## 5-3. 실제로 일어나는 일

```typescript
// ❌ 사고 코드
const amount: number = 1234567890123456789;  // 19자리
console.log(amount);  // 1234567890123456800  ← 마지막 자리 사라짐

// ✓ 안전 코드
const amount: bigint = 1234567890123456789n;
console.log(amount);  // 1234567890123456789n
```

**`n` 접미사**: `bigint` 리터럴 표시. JavaScript 문법.

## 5-4. bigint 사용법

```typescript
// 선언
const a: bigint = 100n;
const b = BigInt("1000000000000000000");  // 문자열에서 변환

// 연산 — number와 섞을 수 없음
const c = a + b;        // OK, bigint
const d = a + 10;       // 에러: bigint와 number 혼용 불가
const e = a + BigInt(10); // OK

// 비교
a > 50n;  // OK
a > 50;   // 에러
```

**중요**: bigint와 number는 *서로 직접 연산 불가*. 명시적으로 변환해야 함.

## 5-5. JSON 직렬화 함정

```typescript
const event = {
  tokenId: 100n,
  amount: 1n
};

JSON.stringify(event);  // ❌ TypeError: Do not know how to serialize a BigInt
```

**JSON은 bigint를 직접 다룰 수 없다.** webhook 보내거나 DB에 저장할 때 항상 string으로 변환:

```typescript
// 보낼 때
JSON.stringify({
  tokenId: event.tokenId.toString(),
  amount: event.amount.toString()
});

// 받을 때 (Java)
BigInteger tokenId = new BigInteger(json.get("tokenId").asString());
```

## 5-6. ethers.js v6에서의 bigint

```typescript
import { Contract } from "ethers";

const balance = await contract.balanceOf(userAddr, tokenId);
console.log(balance);          // 1000000000000000000n (bigint)
console.log(balance.toString()); // "1000000000000000000"

// ethers v5는 BigNumber, v6는 native bigint — 헷갈리지 마세요
```

**교보생명 프로젝트는 ethers v6**. native bigint 쓴다고 가정.

## 5-7. 실수 방지 체크리스트

| 상황 | 권장 |
|---|---|
| Solidity uint256 받기 | **무조건 bigint** |
| JSON으로 보낼 때 | bigint → string |
| Java로 넘길 때 | string → BigInteger |
| 가스, wei, 토큰 amount | **무조건 bigint** |
| 일반 카운터, 인덱스 | number OK |
| Date.now() | number OK (밀리초, 안전 범위 내) |

**의심스러우면 bigint**. 안전한 쪽이 정답.

---

# 6. async/await + Promise (8분)

비동기 처리. Java의 `CompletableFuture`보다 훨씬 자주 씁니다 — TypeScript에서는 *거의 모든 I/O*가 비동기.

## 6-1. Promise란

"미래에 값이 도착할 것"이라는 약속.

```typescript
const promise: Promise<string> = fetch("/api/user")
  .then(res => res.text());
// 이 시점에 promise는 아직 값이 없음. 미래에 string이 도착할 예정.
```

**상태 3가지**:
- **pending**: 진행 중
- **fulfilled**: 성공 (값 도착)
- **rejected**: 실패 (에러 발생)

## 6-2. async/await 문법

`Promise`를 *동기 코드처럼* 작성하는 문법 설탕.

```typescript
// .then 방식 (구식)
function fetchUser(id: string): Promise<User> {
  return fetch(`/users/${id}`)
    .then(res => res.json())
    .then(data => parseUser(data));
}

// async/await 방식 (현대)
async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/users/${id}`);
  const data = await res.json();
  return parseUser(data);
}
```

**규칙**:
- `await`는 `async` 함수 안에서만 사용 가능
- `async` 함수의 반환 타입은 자동으로 `Promise<X>`로 감싸짐

```typescript
async function getNumber(): Promise<number> {
  return 42;  // 실제 타입은 Promise<number>
}
```

## 6-3. 에러 처리 — try/catch

```typescript
async function processRequest(id: string) {
  try {
    const user = await fetchUser(id);
    const result = await mintNFT(user.address);
    return result;
  } catch (err) {
    console.error("처리 실패:", err);
    throw err;  // 다시 던질지 결정
  }
}
```

**Java와 거의 동일**. `try { } catch (Exception e) { }` 패턴.

## 6-4. 병렬 실행 — Promise.all

순차 실행 (느림):

```typescript
async function getMultiple() {
  const a = await fetchUser("u-1");  // 200ms 대기
  const b = await fetchUser("u-2");  // 200ms 또 대기
  const c = await fetchUser("u-3");  // 200ms 또 대기
  return [a, b, c];  // 총 600ms
}
```

병렬 실행 (빠름):

```typescript
async function getMultiple() {
  const [a, b, c] = await Promise.all([
    fetchUser("u-1"),
    fetchUser("u-2"),
    fetchUser("u-3"),
  ]);
  return [a, b, c];  // 총 200ms (가장 느린 것 기준)
}
```

**dispatch 패턴에서 자주 봄**:

```typescript
await Promise.all(matched.map(h => h.handle(event)));
// 모든 핸들러를 동시에 실행하고, 다 끝날 때까지 기다림
```

## 6-5. await 빠뜨리는 함정

⚠️ **가장 흔한 실수**:

```typescript
async function process() {
  fetchUser("u-1");  // ❌ await 빠짐
  console.log("끝");  // 즉시 출력, fetchUser는 백그라운드에서 돌고 있음
}

async function process() {
  await fetchUser("u-1");  // ✓ 완료까지 대기
  console.log("끝");  // fetchUser 끝난 후 출력
}
```

await 빠뜨리면 *함수가 끝났다고 생각하지만 백그라운드에선 아직 돌고 있음*. 데이터 정합성 문제 발생.

**TypeScript 컴파일러가 잡아주는 경우도 있음**: `Promise<void>`를 반환하는 함수를 await 없이 호출하면 경고. 하지만 모든 케이스를 잡지는 못하니 의식적으로 챙겨야 함.

## 6-6. Java와의 사상 차이

| | Java | TypeScript |
|---|---|---|
| 기본 패러다임 | 동기 (블로킹) | 비동기 (논블로킹) |
| 비동기 도구 | CompletableFuture, ExecutorService | Promise, async/await |
| I/O 호출 | 블로킹 가능 | *거의 항상 Promise* |
| 스레드 모델 | 멀티스레드 | 싱글스레드 + 이벤트 루프 |

**핵심**: Node.js는 싱글스레드라서 비동기가 강제된다. fetch, DB 쿼리, 파일 I/O *전부* Promise.

---

# 7. Java ↔ TypeScript 매핑 표 (10분)

가장 빠르게 배우는 방법: *아는 것에서 모르는 것으로 매핑*.

## 7-1. 타입 시스템

| Java | TypeScript | 비고 |
|---|---|---|
| `String` | `string` | 소문자 |
| `int`, `long`, `double` | `number` | 모두 number 하나로 통합 (64비트 float) |
| `BigInteger` | `bigint` | 큰 정수 |
| `boolean` | `boolean` | 동일 |
| `void` | `void` | 동일 |
| `null` | `null \| undefined` | TS는 두 종류 |
| `List<T>` | `T[]` 또는 `Array<T>` | |
| `Map<K, V>` | `Map<K, V>` 또는 `Record<K, V>` | |
| `Optional<T>` | `T \| undefined` 또는 `T?` | |

## 7-2. 클래스/객체

| Java | TypeScript |
|---|---|
| `class User { ... }` | `class User { ... }` |
| `interface UserRepo` | `interface UserRepo` |
| `extends` | `extends` |
| `implements` | `implements` |
| `final` (필드) | `readonly` |
| `private`, `public`, `protected` | 동일 (단, `#field` 신문법도 있음) |
| `static` | `static` |
| `abstract class` | `abstract class` |

## 7-3. 함수/메서드

| Java | TypeScript |
|---|---|
| `String foo(int x)` | `function foo(x: number): string` |
| `void run()` | `function run(): void` |
| 람다 `x -> x * 2` | 화살표 `(x) => x * 2` |
| `Function<T, R>` | `(arg: T) => R` |
| 가변 인자 `String... args` | `...args: string[]` |
| 오버로딩 (시그니처별 메서드 여러 개) | 가능하지만 드뭄 — 유니온 타입으로 대체 |

## 7-4. 비동기

| Java | TypeScript |
|---|---|
| `CompletableFuture<T>` | `Promise<T>` |
| `.thenApply(...)` | `.then(...)` |
| `.exceptionally(...)` | `.catch(...)` |
| `async`/`await` (자바도 21+) | `async`/`await` (정식 문법) |
| `CompletableFuture.allOf(...)` | `Promise.all([...])` |

## 7-5. 컬렉션 처리

| Java | TypeScript |
|---|---|
| `list.stream().map(x -> x * 2).collect(toList())` | `list.map(x => x * 2)` |
| `list.stream().filter(x -> x > 0).collect(toList())` | `list.filter(x => x > 0)` |
| `list.stream().reduce(0, Integer::sum)` | `list.reduce((acc, x) => acc + x, 0)` |
| `list.forEach(System.out::println)` | `list.forEach(x => console.log(x))` |
| `Optional.ofNullable(x).orElse(default)` | `x ?? default` |

**TypeScript는 stream() 호출 불필요**. 배열에 `map`, `filter`, `reduce`가 직접 있음.

## 7-6. 모듈 시스템

| Java | TypeScript |
|---|---|
| `package com.example` | (디렉토리 구조로 표현) |
| `import com.example.User` | `import { User } from "./user"` |
| `import com.example.*` | `import * as user from "./user"` |
| public 클래스 = 파일 1개 | 한 파일에 여러 export 가능 |

```typescript
// user.ts
export interface User { ... }
export class UserService { ... }
export const DEFAULT_ROLE = "user";

// 다른 파일에서
import { User, UserService, DEFAULT_ROLE } from "./user";
```

## 7-7. 패턴 빠른 변환

```java
// Java: Optional 체인
Optional<String> name = order.getUser()
    .map(User::getAddress)
    .map(Address::getStreet);
```

```typescript
// TypeScript: 옵셔널 체이닝
const name = order.user?.address?.street;
```

```java
// Java: 람다로 컬렉션 처리
List<Long> tokenIds = events.stream()
    .filter(e -> e.getType().equals("MINT"))
    .map(Event::getTokenId)
    .collect(Collectors.toList());
```

```typescript
// TypeScript: 동일 작업
const tokenIds = events
  .filter(e => e.type === "MINT")
  .map(e => e.tokenId);
```

---

# 8. 자주 만나는 에러 메시지 3개 (10분)

실습 중 막히는 90%는 이 셋.

## 8-1. `Object is possibly 'null'` / `'undefined'`

가장 자주 만남. null/undefined 가능성을 명시한 변수에 그대로 접근하려 할 때.

```typescript
function findUser(id: string): User | null { ... }

const user = findUser("u-1");
console.log(user.name);  // ❌ 에러
```

**해결 4가지**:

```typescript
// 방법 1: if 체크
if (user !== null) {
  console.log(user.name);  // ✓ 좁혀짐
}

// 방법 2: 옵셔널 체이닝
console.log(user?.name);  // ✓ user가 null이면 undefined 반환

// 방법 3: nullish 병합 (기본값)
const name = user?.name ?? "Anonymous";

// 방법 4: Non-null assertion (최후의 수단)
console.log(user!.name);  // "절대 null 아님" 단언 — 책임은 본인
```

⚠️ **`!` 연산자는 *정말 null이 아닌 게 보장될 때만*** 사용. 잘못 쓰면 런타임에 폭발.

## 8-2. `Property 'foo' does not exist on type 'Bar'`

객체에 없는 속성 접근.

```typescript
interface User { 
  id: string; 
  name: string; 
}

const user: User = { id: "u-1", name: "Sharon" };
console.log(user.email);  // ❌ 에러: User에 email 없음
```

**원인 진단**:

| 증상 | 원인 | 해결 |
|---|---|---|
| 오타 | `user.nmae` | 오타 수정 |
| 필드 빠짐 | 인터페이스에 정의 안 됨 | 인터페이스에 추가 |
| 잘못된 타입 | 변수가 다른 타입 | 타입 확인 |
| 라이브러리 미지원 | `@types/...` 패키지 없음 | `npm i -D @types/lib` |

```typescript
// 해결 예시: 인터페이스에 추가
interface User {
  id: string;
  name: string;
  email?: string;  // 옵셔널로 추가
}
```

## 8-3. `Type 'X' is not assignable to type 'Y'`

가장 모호한 에러. 타입이 안 맞음.

```typescript
function processStatus(status: "pending" | "confirmed") { ... }

const s: string = "pending";
processStatus(s);  // ❌ string은 "pending" | "confirmed"가 아님
```

**왜 에러인가**: TypeScript는 `string`이 `"pending"`보다 *더 넓은* 타입이라서 좁은 타입에 넣을 수 없다고 본다.

**해결**:

```typescript
// 방법 1: 좁은 타입으로 선언
const s: "pending" = "pending";
processStatus(s);  // ✓

// 방법 2: as const
const s = "pending" as const;  // 타입이 "pending"으로 좁혀짐
processStatus(s);  // ✓

// 방법 3: 타입 단언 (최후 수단)
processStatus(s as "pending" | "confirmed");
```

## 8-4. 응급 처치 vs 근본 해결

⚠️ 에러 막혔을 때 *가장 흔한 실수*:

```typescript
// ❌ 위험 — 모든 에러 우회
const user: any = findUser("u-1");
console.log(user.literally.anything);  // 컴파일 통과, 런타임 폭발
```

```typescript
// ❌ 위험 — 타입 단언으로 무리한 변환
const data = response as User;  // 실제로 User가 아닐 수 있음
```

**원칙**: 에러는 *대부분 진짜 버그를 가리킨다*. 우회하지 말고 *왜 그 에러가 떴는지* 이해하고 고칠 것.

`any`와 `as`는 *최후의 수단*. 보일러플레이트 줄이려고 남용하면 TypeScript 쓰는 의미가 없어진다.

---

# 부록 A — 즉시 사용 치트시트

## A-1. 가장 자주 쓰는 패턴 10개

```typescript
// 1. 타입 표기
const x: string = "hello";

// 2. 함수
function foo(x: number, y: number): number { return x + y; }
const bar = (x: number, y: number): number => x + y;

// 3. interface
interface User { id: string; name: string; email?: string; }

// 4. 유니온
type Status = "active" | "inactive";

// 5. 제네릭
async function fetchOne<T>(url: string): Promise<T> { ... }

// 6. async/await
const user = await fetchUser("u-1");

// 7. Promise.all
const [a, b] = await Promise.all([fetchA(), fetchB()]);

// 8. 옵셔널 체이닝
const name = user?.profile?.name ?? "Unknown";

// 9. bigint
const amount = 1000000000000000000n;

// 10. 디스트럭처링
const { id, name } = user;
const [first, second] = arr;
```

## A-2. 자주 쓰는 표준 라이브러리

```typescript
// 배열
arr.map(x => x * 2);
arr.filter(x => x > 0);
arr.find(x => x.id === "u-1");
arr.reduce((acc, x) => acc + x, 0);
arr.includes(item);

// 객체
Object.keys(obj);    // 키 배열
Object.values(obj);  // 값 배열
Object.entries(obj); // [key, value][] 배열

// JSON
JSON.stringify(obj);
JSON.parse(str);

// Promise
Promise.all([...]);  // 모두 성공 또는 첫 실패
Promise.race([...]); // 가장 먼저 끝나는 것
```

---

# 부록 B — 5분 셀프 점검 (강의 종료 후)

다음 코드를 각자 *읽고 무엇을 하는지* 설명할 수 있으면 1차 통과.

```typescript
interface ChainEvent {
  eventName: string;
  contractAddr: string;
  txHash: string;
  blockNumber: number;
  args: Record<string, unknown>;
}

interface IEventHandler {
  readonly eventName: string;
  readonly contractAddr?: string;
  handle(event: ChainEvent): Promise<void>;
}

class EventDispatcher {
  constructor(private handlers: IEventHandler[]) {}

  async dispatch(event: ChainEvent): Promise<void> {
    const matched = this.handlers.filter(
      h => h.eventName === event.eventName &&
           (!h.contractAddr || h.contractAddr === event.contractAddr),
    );
    
    await Promise.all(matched.map(h => h.handle(event)));
  }
}
```

**셀프 체크리스트**:

- [ ] `interface ChainEvent`가 무엇을 정의하는지 설명할 수 있다
- [ ] `Record<string, unknown>`이 무슨 의미인지 안다
- [ ] `readonly contractAddr?`에서 `?`와 `readonly`의 역할을 안다
- [ ] `Promise<void>`가 "비동기, 반환값 없음"임을 안다
- [ ] `private handlers: IEventHandler[]`이 생성자 매개변수 + 필드 선언임을 안다
- [ ] `filter` 안의 화살표 함수가 무엇을 걸러내는지 설명할 수 있다
- [ ] `Promise.all`이 왜 `await`와 함께 쓰였는지 안다

**모든 항목 체크되면**: 1순위 강의(M2)로 진입 준비 완료.
**3개 이하**: 핸드아웃 1~6장 다시 훑어볼 것.

---

# 부록 C — 다음 단계

이 워밍업 이후에 자연스럽게 만나게 될 TS 개념들 (지금은 몰라도 됨, 만났을 때 핸드아웃 다시 펴보면 됨):

- **유틸리티 타입**: `Partial<T>`, `Pick<T, K>`, `Omit<T, K>`, `Record<K, V>`
- **타입 가드**: `typeof`, `instanceof`, 사용자 정의 가드 `is`
- **클래스 데코레이터**: `@Injectable()`, `@Controller()` (NestJS 등)
- **Conditional types**: `T extends U ? X : Y`
- **타입 추론 utility**: `ReturnType<T>`, `Parameters<T>`

50시간 커리큘럼 진행하면서 자연스럽게 노출됩니다. *지금은 1~8장만 잡으면 충분*.

---

**작성: 2026 / 교보생명 디지털 자산 인프라 과정 / Day 1**
