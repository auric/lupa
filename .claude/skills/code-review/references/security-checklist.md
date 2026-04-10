# Security Checklist

Quick reference for security review. Use when analyzing changes for vulnerabilities.

## Authentication & Session

| Check               | Severity | Look For                                |
| ------------------- | -------- | --------------------------------------- |
| Password comparison | CRITICAL | Timing attacks (`===` vs constant-time) |
| Token validation    | CRITICAL | Missing signature verification          |
| Session fixation    | HIGH     | Session ID unchanged after login        |
| Credential storage  | CRITICAL | Plaintext passwords, weak hashing       |
| MFA bypass          | CRITICAL | Logic flaws in MFA flow                 |

```typescript
// ❌ Timing attack vulnerable
if (password === storedPassword) {
}

// ✅ Constant-time comparison
import { timingSafeEqual } from 'crypto';
if (timingSafeEqual(Buffer.from(a), Buffer.from(b))) {
}
```

## Authorization

| Check                | Severity | Look For                                         |
| -------------------- | -------- | ------------------------------------------------ |
| Missing auth checks  | CRITICAL | Endpoints without permission validation          |
| IDOR                 | CRITICAL | Direct object references without ownership check |
| Privilege escalation | CRITICAL | Role checks that can be bypassed                 |
| Default deny         | HIGH     | Missing fallback to deny access                  |

```typescript
// ❌ IDOR vulnerability
app.get('/user/:id', (req, res) => {
    const user = db.getUser(req.params.id); // No ownership check
});

// ✅ Check ownership
app.get('/user/:id', (req, res) => {
    if (req.user.id !== req.params.id && !req.user.isAdmin) {
        return res.status(403);
    }
});
```

## Injection

| Check             | Severity | Look For                        |
| ----------------- | -------- | ------------------------------- |
| SQL injection     | CRITICAL | String concatenation in queries |
| Command injection | CRITICAL | User input in shell commands    |
| XSS               | HIGH     | Unescaped output, `innerHTML`   |
| Path traversal    | HIGH     | User input in file paths        |
| LDAP injection    | HIGH     | Unescaped LDAP queries          |

```typescript
// ❌ SQL injection
db.query(`SELECT * FROM users WHERE id = '${userId}'`);

// ✅ Parameterized query
db.query('SELECT * FROM users WHERE id = ?', [userId]);

// ❌ Command injection
exec(`convert ${userFile} output.png`);

// ✅ Use execFile with array args
execFile('convert', [userFile, 'output.png']);
```

## Secrets & Data Exposure

| Check                 | Severity | Look For                    |
| --------------------- | -------- | --------------------------- |
| Hardcoded secrets     | CRITICAL | API keys, passwords in code |
| Logged secrets        | HIGH     | Credentials in log output   |
| Error disclosure      | MEDIUM   | Stack traces to users       |
| Comments with secrets | HIGH     | Credentials in comments     |

```typescript
// ❌ Hardcoded secret
const API_KEY = 'sk-live-abc123xyz';

// ✅ Environment variable
const API_KEY = process.env.API_KEY;

// ❌ Logging credentials
console.log('Login attempt:', { username, password });

// ✅ Redact sensitive fields
console.log('Login attempt:', { username, password: '[REDACTED]' });
```

## Cryptography

| Check           | Severity | Look For                        |
| --------------- | -------- | ------------------------------- |
| Weak algorithms | CRITICAL | MD5, SHA1 for security purposes |
| ECB mode        | HIGH     | AES-ECB (predictable patterns)  |
| Weak RNG        | CRITICAL | `Math.random()` for security    |
| Missing salt    | HIGH     | Unsalted password hashes        |

```typescript
// ❌ Weak RNG
const token = Math.random().toString(36);

// ✅ Cryptographic RNG
import { randomBytes } from 'crypto';
const token = randomBytes(32).toString('hex');

// ❌ Weak hash
const hash = md5(password);

// ✅ Strong password hash
import { hash } from 'bcrypt';
const hashed = await hash(password, 12);
```

## Input Validation

| Check              | Severity | Look For                       |
| ------------------ | -------- | ------------------------------ |
| Missing validation | HIGH     | Trusting user input            |
| Type coercion      | MEDIUM   | Loose equality with user input |
| Size limits        | MEDIUM   | Unbounded file uploads, arrays |
| Format validation  | MEDIUM   | Invalid email, URL parsing     |

```typescript
// ❌ No validation
const { age } = req.body;
db.insert({ age });

// ✅ Validate with schema
const schema = z.object({ age: z.number().min(0).max(150) });
const { age } = schema.parse(req.body);
```

## TypeScript-Specific

| Check                   | Severity | Look For                                |
| ----------------------- | -------- | --------------------------------------- |
| Type assertions         | MEDIUM   | `as any`, `as unknown` bypassing safety |
| Optional chaining abuse | MEDIUM   | `?.` hiding potential null bugs         |
| Type predicates         | MEDIUM   | Incorrect type narrowing                |
| `@ts-ignore`            | HIGH     | Suppressing legitimate errors           |

```typescript
// ❌ Dangerous assertion
const user = data as User; // No runtime check

// ✅ Runtime validation
const user = userSchema.parse(data); // Throws if invalid
```

## External Research Triggers

Use DeepWiki/Tavily when:

- Unfamiliar authentication library
- Cryptographic primitive usage
- OAuth/OIDC implementation
- JWT handling patterns
- Rate limiting implementation
- CORS configuration
