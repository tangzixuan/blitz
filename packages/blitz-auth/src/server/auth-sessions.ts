import {fromBase64, toBase64} from "b64-lite"
import cookie, {parse} from "cookie"
import jsonwebtoken from "jsonwebtoken"
import {
  assert,
  isPast,
  differenceInMinutes,
  addYears,
  addMinutes,
  Ctx,
  AuthenticationError,
  AuthorizationError,
  CSRFTokenMismatchError,
  log,
  AuthenticatedCtx,
  baseLogger,
  chalk,
} from "blitz"
import {
  EmptyPublicData,
  PublicData,
  IsAuthorizedArgs,
  SessionContext,
  COOKIE_ANONYMOUS_SESSION_TOKEN,
  COOKIE_CSRF_TOKEN,
  COOKIE_PUBLIC_DATA_TOKEN,
  COOKIE_REFRESH_TOKEN,
  COOKIE_SESSION_TOKEN,
  HANDLE_SEPARATOR,
  HEADER_CSRF,
  HEADER_CSRF_ERROR,
  HEADER_PUBLIC_DATA_TOKEN,
  HEADER_SESSION_CREATED,
  SESSION_TOKEN_VERSION_0,
  SESSION_TYPE_ANONYMOUS_JWT,
  SESSION_TYPE_OPAQUE_TOKEN_SIMPLE,
  TOKEN_SEPARATOR,
  AuthenticatedSessionContext,
} from "../shared"
import {generateToken, hash256} from "./auth-utils"
import {formatWithValidation} from "../shared/url-utils"

import type {UrlObject} from "url"
import type {IncomingMessage, ServerResponse} from "http"

function splitCookiesString(cookiesString: string) {
  if (!cookiesString) return []
  let cookiesStrings = []
  let pos = 0
  let start
  let ch
  let lastComma
  let nextStart
  let cookiesSeparatorFound
  function skipWhitespace() {
    while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) {
      pos += 1
    }
    return pos < cookiesString.length
  }
  function notSpecialChar() {
    ch = cookiesString.charAt(pos)
    return ch !== "=" && ch !== ";" && ch !== ","
  }
  while (pos < cookiesString.length) {
    start = pos
    cookiesSeparatorFound = false
    while (skipWhitespace()) {
      ch = cookiesString.charAt(pos)
      if (ch === ",") {
        lastComma = pos
        pos += 1
        skipWhitespace()
        nextStart = pos
        while (pos < cookiesString.length && notSpecialChar()) {
          pos += 1
        }
        if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
          cookiesSeparatorFound = true
          pos = nextStart
          cookiesStrings.push(cookiesString.substring(start, lastComma))
          start = pos
        } else {
          pos = lastComma + 1
        }
      } else {
        pos += 1
      }
    }
    if (!cookiesSeparatorFound || pos >= cookiesString.length) {
      cookiesStrings.push(cookiesString.substring(start, cookiesString.length))
    }
  }
  return cookiesStrings
}

export function isLocalhost(req: IncomingMessage | Request): boolean {
  let host: string | undefined
  if (req instanceof Request) {
    host = req.headers.get("host") || ""
  } else {
    host = req.headers.host || ""
  }
  let localhost = false
  if (host) {
    host = host.split(":")[0]
    localhost = host === "localhost"
  }
  return localhost
}

/**
 * Parse cookies from the `headers` of request
 * @param req request object
 */
export function getCookieParser(headers: {[key: string]: undefined | string | string[]}) {
  return function parseCookie() {
    const header: undefined | string | string[] = headers.cookie

    if (!header) {
      return {}
    }

    return parse(Array.isArray(header) ? header.join(";") : header)
  }
}

import Debug from "debug"
const debug = Debug("blitz:session")

export interface SimpleRolesIsAuthorized<RoleType = string> {
  ({ctx, args}: {ctx: any; args: [roleOrRoles?: RoleType | RoleType[]]}): boolean
}
export const simpleRolesIsAuthorized: SimpleRolesIsAuthorized = ({ctx, args}) => {
  const [roleOrRoles] = args
  const publicData = (ctx.session as SessionContext).$publicData as
    | {roles: unknown}
    | {role: unknown}

  if ("role" in publicData && "roles" in publicData) {
    throw new Error("Session publicData can only have only `role` or `roles`, but not both.'")
  }

  let roles: string[] = []
  if ("role" in publicData) {
    if (typeof publicData.role !== "string") {
      throw new Error("Session publicData.role field must be a string")
    }
    roles.push(publicData.role)
  } else if ("roles" in publicData) {
    if (!Array.isArray(publicData.roles)) {
      throw new Error("Session `publicData.roles` is not an array, but it must be")
    }
    roles = publicData.roles
  } else {
    throw new Error("Session publicData is missing the required `role` or roles` field")
  }

  // No roles required, so all roles allowed
  if (!roleOrRoles) return true

  const rolesToAuthorize: string[] = []
  if (Array.isArray(roleOrRoles)) {
    rolesToAuthorize.push(...roleOrRoles)
  } else if (roleOrRoles) {
    rolesToAuthorize.push(roleOrRoles)
  }
  for (const role of rolesToAuthorize) {
    if (roles.includes(role)) return true
  }
  return false
}

type JwtPayload = AnonymousSessionPayload | null
type AnonSessionKernel = {
  handle: string
  publicData: EmptyPublicData
  jwtPayload: JwtPayload
  antiCSRFToken: string
  anonymousSessionToken: string
}
type AuthedSessionKernel = {
  handle: string
  publicData: PublicData
  jwtPayload: JwtPayload
  antiCSRFToken: string
  sessionToken: string
}
type SessionKernel = AnonSessionKernel | AuthedSessionKernel

function ensureMiddlewareResponse(
  res: ServerResponse & {[key: string]: any},
): asserts res is ServerResponse & {blitzCtx: Ctx} {
  if (!("blitzCtx" in res)) {
    res.blitzCtx = {} as Ctx
  }
}

function convertRequestToHeader(req: IncomingMessage | Request): Headers {
  const headersFromRequest = req.headers
  if (headersFromRequest instanceof Headers) {
    return headersFromRequest
  } else {
    const headers = new Headers()
    Object.entries(headersFromRequest).forEach(([key, value]) => {
      if (value) {
        if (Array.isArray(value)) {
          headers.append(key, value.join(","))
        } else {
          headers.append(key, value)
        }
      }
    })
    return headers
  }
}

function getCookiesFromHeader(headers: Headers) {
  const cookieHeader = headers.get("Cookie")
  if (cookieHeader) {
    return cookie.parse(cookieHeader)
  } else {
    return {}
  }
}

export async function getSession(req: Request): Promise<SessionContext>
export async function getSession(req: Request, res: never, isRsc: boolean): Promise<SessionContext>
export async function getSession(req: IncomingMessage, res: ServerResponse): Promise<SessionContext>
export async function getSession(
  req: IncomingMessage,
  res: ServerResponse,
  isRsc: boolean,
): Promise<SessionContext>
export async function getSession(
  req: IncomingMessage | Request,
  res?: ServerResponse,
  isRsc?: boolean,
): Promise<SessionContext> {
  const headers = convertRequestToHeader(req)
  if (res) {
    ensureMiddlewareResponse(res)
    debug("cookiePrefix", globalThis.__BLITZ_SESSION_COOKIE_PREFIX)
    if (res.blitzCtx.session) {
      debug("Returning existing session")
      return res.blitzCtx.session
    }
  }
  const method = req.method
  let sessionKernel = await getSessionKernel({headers, method})

  if (sessionKernel) {
    debug("Got existing session", sessionKernel)
  }

  if (!sessionKernel) {
    sessionKernel = await createAnonymousSession({headers})
  }

  const sessionContext = makeProxyToPublicData(
    new SessionContextClass(headers, sessionKernel, !!isRsc, res),
  )
  debug("New session context")
  if (res) {
    ;(res as any).blitzCtx = {
      session: sessionContext,
    }
    sessionContext.setSession(res)
  }
  return sessionContext
}

interface RouteUrlObject extends Pick<UrlObject, "pathname" | "query" | "href"> {
  pathname: string
}

const makeProxyToPublicData = <T extends SessionContextClass>(ctxClass: T): T => {
  return new Proxy(ctxClass, {
    get(target, prop, receiver) {
      if (prop in target || prop === "then") {
        return Reflect.get(target, prop, receiver)
      } else {
        return Reflect.get(target.$publicData, prop, receiver)
      }
    },
  })
}

export async function getBlitzContext(): Promise<Ctx> {
  try {
    const {headers, cookies} = require("next/headers")
    const cookieStore = await cookies()
    const headersStore = await headers()
    const reqHeader = Object.fromEntries(headersStore)
    const csrfToken = cookieStore.get(COOKIE_CSRF_TOKEN())
    if (csrfToken) {
      reqHeader[HEADER_CSRF] = csrfToken.value
    }
    const session = await getSession(
      {
        headers: new Headers(reqHeader),
        method: "POST",
      } as Request,
      null as never,
      true,
    )
    const ctx: Ctx = {
      session,
    }
    return ctx
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Usage of `getBlitzContext` is supported only in next.js 13.0.0 and above. Please upgrade your next.js version.",
      )
    }
    throw e
  }
}

export async function useAuthenticatedBlitzContext({
  redirectTo,
  redirectAuthenticatedTo,
  role,
}: {
  redirectTo?: string | RouteUrlObject
  redirectAuthenticatedTo?: string | RouteUrlObject | ((ctx: Ctx) => string | RouteUrlObject)
  role?: string | string[]
}): Promise<AuthenticatedCtx> {
  const log = baseLogger().getSubLogger({name: "useAuthenticatedBlitzContext"})
  const customChalk = new chalk.Instance({
    level: log.settings.type === "json" ? 0 : chalk.level,
  })
  const ctx: Ctx = await getBlitzContext()
  const userId = ctx.session.userId
  try {
    const {redirect} = require("next/navigation")
    if (userId) {
      debug("[useAuthenticatedBlitzContext] User is authenticated")
      if (redirectAuthenticatedTo) {
        if (typeof redirectAuthenticatedTo === "function") {
          redirectAuthenticatedTo = redirectAuthenticatedTo(ctx)
        }
        const redirectUrl =
          typeof redirectAuthenticatedTo === "string"
            ? redirectAuthenticatedTo
            : formatWithValidation(redirectAuthenticatedTo)
        debug("[useAuthenticatedBlitzContext] Redirecting to", redirectUrl)
        if (role) {
          try {
            ctx.session.$authorize(role)
          } catch (e) {
            log.info("Authentication Redirect: " + customChalk.dim(`Role ${role}`), redirectTo)
            redirect(redirectUrl)
          }
        } else {
          log.info("Authentication Redirect: " + customChalk.dim("(Authenticated)"), redirectUrl)
          redirect(redirectUrl)
        }
      }
      if (redirectTo && role) {
        debug("[useAuthenticatedBlitzContext] redirectTo and role are both defined.")
        try {
          ctx.session.$authorize(role)
        } catch (e) {
          log.error("Authorization Error: " + (e as Error).message)
          if (typeof redirectTo !== "string") {
            redirectTo = formatWithValidation(redirectTo)
          }
          log.info("Authorization Redirect: " + customChalk.dim(`Role ${role}`), redirectTo)
          redirect(redirectTo)
        }
      }
    } else {
      debug("[useAuthenticatedBlitzContext] User is not authenticated")
      if (redirectTo) {
        if (typeof redirectTo !== "string") {
          redirectTo = formatWithValidation(redirectTo)
        }
        log.info("Authentication Redirect: " + customChalk.dim("(Not authenticated)"), redirectTo)
        redirect(redirectTo)
      }
    }
    return ctx as AuthenticatedCtx
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Usage of `useAuthenticatedBlitzContext` is supported only in next.js 13.0.0 and above. Please upgrade your next.js version.",
      )
    }
    throw e
  }
}

const NotSupportedMessage = async (method: string) => {
  const message = `Method ${method} is not yet supported in React Server Components`
  const _box = await log.box(message, log.chalk.hex("8a3df0").bold("Blitz Auth"))
  console.log(_box)
}

export class SessionContextClass implements SessionContext {
  private _headers: Headers
  private _kernel: SessionKernel
  private _isRsc: boolean
  private _response?: ServerResponse

  private static headersToIncludeInResponse = [
    HEADER_CSRF,
    HEADER_CSRF_ERROR,
    HEADER_PUBLIC_DATA_TOKEN,
    HEADER_SESSION_CREATED,
  ]

  constructor(headers: Headers, kernel: SessionKernel, isRsc: boolean, response?: ServerResponse) {
    this._headers = headers
    this._kernel = kernel
    this._isRsc = isRsc
    this._response = response
  }

  $antiCSRFToken() {
    return this._kernel.antiCSRFToken
  }

  get $handle() {
    return this._kernel.handle
  }
  get userId() {
    return this._kernel.publicData.userId
  }
  get $publicData() {
    return this._kernel.publicData
  }

  $authorize(...args: IsAuthorizedArgs) {
    const e = new AuthenticationError()
    Error.captureStackTrace(e, this.$authorize)
    if (!this.userId) throw e

    if (!this.$isAuthorized(...args)) {
      const err = new AuthorizationError()
      Error.captureStackTrace(err, this.$authorize)
      throw err
    }
  }

  $isAuthorized(...args: IsAuthorizedArgs) {
    if (!this.userId) return false

    return global.sessionConfig.isAuthorized({
      ctx: {
        session: this as AuthenticatedSessionContext,
      },
      args,
    })
  }

  $thisIsAuthorized(...args: IsAuthorizedArgs): this is AuthenticatedSessionContext {
    return this.$isAuthorized(...args)
  }

  setSession(response: Response | ServerResponse) {
    if (this._isRsc) {
      void NotSupportedMessage("setSession")
      return
    }
    const cookieHeaders = this._headers.get("set-cookie")
    if (response instanceof Response) {
      response.headers.append("Set-Cookie", cookieHeaders!)
    } else {
      append(response, "Set-Cookie", splitCookiesString(cookieHeaders!))
    }

    const headers = this._headers.entries()
    for (const [key, value] of headers) {
      if (SessionContextClass.headersToIncludeInResponse.includes(key)) {
        if (response instanceof Response) {
          response.headers.set(key, value)
        } else {
          response.setHeader(key, value)
        }
      }
    }
  }

  async $create(publicData: PublicData, privateData?: Record<any, any>) {
    if (this._isRsc) {
      void NotSupportedMessage("$create")
      return
    }
    this._kernel = await createNewSession({
      headers: this._headers,
      publicData,
      privateData,
      jwtPayload: this._kernel.jwtPayload,
      anonymous: false,
    })

    if (this._response) this.setSession(this._response)
  }

  async $revoke() {
    if (this._isRsc) {
      void NotSupportedMessage("$revoke")
      return
    }
    this._kernel = await revokeSession(this._headers, this.$handle)
    if (this._response) this.setSession(this._response)
  }

  async $revokeAll() {
    if (this._isRsc) {
      void NotSupportedMessage("$revokeAll")
      return
    }
    // revoke the current session which uses req/res
    await this.$revoke()
    // revoke other sessions for which there is no req/res object
    await revokeAllSessionsForUser(this.$publicData.userId)
    return
  }

  async $setPublicData(data: Record<any, any>) {
    if (this._isRsc) {
      void NotSupportedMessage("$setPublicData")
      return
    }
    if (this.userId) {
      await syncPubicDataFieldsForUserIfNeeded(this.userId, data)
    }
    this._kernel.publicData = await setPublicData(this._headers, this._kernel, data)
    if (this._response) this.setSession(this._response)
  }

  async $getPrivateData() {
    return (await getPrivateData(this.$handle)) || {}
  }

  async $setPrivateData(data: Record<any, any>) {
    if (this._isRsc) {
      void NotSupportedMessage("$setPrivateData")
      return Promise.resolve()
    }
    await setPrivateData(this._kernel, data)
    if (this._response) this.setSession(this._response)
  }
}

// --------------------------------
// Token/handle utils
// --------------------------------
const TOKEN_LENGTH = 32

const generateEssentialSessionHandle = () => {
  return generateToken(TOKEN_LENGTH) + HANDLE_SEPARATOR + SESSION_TYPE_OPAQUE_TOKEN_SIMPLE
}

const generateAnonymousSessionHandle = () => {
  return generateToken(TOKEN_LENGTH) + HANDLE_SEPARATOR + SESSION_TYPE_ANONYMOUS_JWT
}

const createSessionToken = (handle: string, publicData: PublicData | string) => {
  // We store the hashed public data in the opaque token so that when we verify,
  // we can detect changes in it and return a new set of tokens if necessary.

  let publicDataString
  if (typeof publicData === "string") {
    publicDataString = publicData
  } else {
    publicDataString = JSON.stringify(publicData)
  }
  return toBase64(
    [handle, generateToken(TOKEN_LENGTH), hash256(publicDataString), SESSION_TOKEN_VERSION_0].join(
      TOKEN_SEPARATOR,
    ),
  )
}

const parseSessionToken = (token: string) => {
  const [handle, id, hashedPublicData, version] = fromBase64(token).split(TOKEN_SEPARATOR)

  if (!handle || !id || !hashedPublicData || !version) {
    throw new AuthenticationError("Failed to parse session token")
  }

  return {
    handle,
    id,
    hashedPublicData,
    version,
  }
}

const createPublicDataToken = (publicData: string | PublicData | EmptyPublicData) => {
  const payload = typeof publicData === "string" ? publicData : JSON.stringify(publicData)
  return toBase64(payload)
}

const createAntiCSRFToken = () => generateToken(TOKEN_LENGTH)

export type AnonymousSessionPayload = {
  isAnonymous: true
  handle: string
  publicData: EmptyPublicData
  antiCSRFToken: string
}

const getSessionSecretKey = () => {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.SESSION_SECRET_KEY && process.env.SECRET_SESSION_KEY) {
      throw new Error(
        "You need to rename the SECRET_SESSION_KEY environment variable to SESSION_SECRET_KEY (but don't feel bad, we've all done it :)",
      )
    }
    assert(
      process.env.SESSION_SECRET_KEY,
      "You must provide the SESSION_SECRET_KEY environment variable in production. This is used to sign and verify tokens. It should be 32 chars long.",
    )
    assert(
      process.env.SESSION_SECRET_KEY!.length >= 32,
      "The SESSION_SECRET_KEY environment variable must be at least 32 bytes for sufficent token security",
    )

    return process.env.SESSION_SECRET_KEY
  } else {
    return process.env.SESSION_SECRET_KEY || "default-dev-secret"
  }
}

const JWT_NAMESPACE = "blitzjs"
const JWT_ISSUER = "blitzjs"
const JWT_AUDIENCE = "blitzjs"
const JWT_ANONYMOUS_SUBJECT = "anonymous"
const JWT_ALGORITHM = "HS256"

const createAnonymousSessionToken = (payload: AnonymousSessionPayload) => {
  return jsonwebtoken.sign({[JWT_NAMESPACE]: payload}, getSessionSecretKey() || "", {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: JWT_ANONYMOUS_SUBJECT,
  })
}

const parseAnonymousSessionToken = (token: string) => {
  // This must happen outside the try/catch because it could throw an error
  // about a missing environment variable
  const secret = getSessionSecretKey()

  try {
    const fullPayload = jsonwebtoken.verify(token, secret!, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      subject: JWT_ANONYMOUS_SUBJECT,
    })

    if (typeof fullPayload === "object") {
      return (fullPayload as any)[JWT_NAMESPACE] as AnonymousSessionPayload
    } else {
      return null
    }
  } catch (error) {
    return null
  }
}

const cookieOptions = (headers: Headers, expires: Date, httpOnly: boolean) => {
  return {
    path: "/",
    secure:
      global.sessionConfig.secureCookies &&
      !isLocalhost({
        headers,
      } as Request),
    sameSite: global.sessionConfig.sameSite,
    domain: global.sessionConfig.domain,
    expires: new Date(expires),
    httpOnly,
  }
}

function replaceOrAppendValueInSetCookieHeader(
  headers: Headers,
  cookieName: string,
  newValue: string,
): string {
  const cookies = headers.get("set-cookie")
  if (!cookies) return newValue
  const cookiesAsArray = splitCookiesString(cookies!)
  for (let i = 0; i < cookiesAsArray.length; i++) {
    const cookie = cookiesAsArray[i]
    if (cookie?.startsWith(cookieName)) {
      cookiesAsArray[i] = newValue
      return cookiesAsArray.join(", ")
    } else {
      if (i === cookiesAsArray.length - 1) {
        cookiesAsArray.push(newValue)
        return cookiesAsArray.join(", ")
      }
    }
  }
  return cookiesAsArray.filter(Boolean).join(", ")
}

const setSessionCookie = (headers: Headers, sessionToken: string, expiresAt: Date) => {
  const sessionCookie = cookie.serialize(
    COOKIE_SESSION_TOKEN(),
    sessionToken,
    cookieOptions(headers, expiresAt, true),
  )
  const newCookies = replaceOrAppendValueInSetCookieHeader(
    headers,
    COOKIE_SESSION_TOKEN(),
    sessionCookie,
  )
  headers.set("Set-Cookie", newCookies)
}

const setAnonymousSessionCookie = (headers: Headers, token: string, expiresAt: Date) => {
  const anonCookie = cookie.serialize(
    COOKIE_ANONYMOUS_SESSION_TOKEN(),
    token,
    cookieOptions(headers, expiresAt, true),
  )
  const newCookies = replaceOrAppendValueInSetCookieHeader(
    headers,
    COOKIE_ANONYMOUS_SESSION_TOKEN(),
    anonCookie,
  )
  headers.set("Set-Cookie", newCookies)
}

const setCSRFCookie = (headers: Headers, antiCSRFToken: string, expiresAt: Date) => {
  debug("setCSRFCookie", antiCSRFToken)
  assert(antiCSRFToken !== undefined, "Internal error: antiCSRFToken is being set to undefined")
  const csrfCookie = cookie.serialize(
    COOKIE_CSRF_TOKEN(),
    antiCSRFToken,
    cookieOptions(headers, expiresAt, false),
  )

  const newCookies = replaceOrAppendValueInSetCookieHeader(headers, COOKIE_CSRF_TOKEN(), csrfCookie)
  headers.set("Set-Cookie", newCookies)
}

const setPublicDataCookie = (headers: Headers, publicDataToken: string, expiresAt: Date) => {
  headers.set(HEADER_PUBLIC_DATA_TOKEN, "updated")
  const publicDataCookie = cookie.serialize(
    COOKIE_PUBLIC_DATA_TOKEN(),
    publicDataToken,
    cookieOptions(headers, expiresAt, false),
  )
  const newCookies = replaceOrAppendValueInSetCookieHeader(
    headers,
    COOKIE_PUBLIC_DATA_TOKEN(),
    publicDataCookie,
  )
  headers.set("Set-Cookie", newCookies)
}

// --------------------------------
// Get Session
// --------------------------------
async function getSessionKernel({
  headers,
  method,
}: {
  headers: Headers
  method: string | undefined
}): Promise<SessionKernel | null> {
  const cookies = getCookiesFromHeader(headers)
  const anonymousSessionToken = cookies[COOKIE_ANONYMOUS_SESSION_TOKEN()]
  const sessionToken = cookies[COOKIE_SESSION_TOKEN()] // for essential method
  const idRefreshToken = cookies[COOKIE_REFRESH_TOKEN()] // for advanced method
  const antiCSRFToken = headers.get(HEADER_CSRF)
  debug("getSessionKernel", {
    anonymousSessionToken,
    sessionToken,
    idRefreshToken,
    antiCSRFToken,
  })

  const enableCsrfProtection =
    method !== "GET" &&
    method !== "OPTIONS" &&
    method !== "HEAD" &&
    !process.env.DANGEROUSLY_DISABLE_CSRF_PROTECTION

  if (sessionToken) {
    debug("[getSessionKernel] Request has sessionToken")
    const {handle, version, hashedPublicData} = parseSessionToken(sessionToken)

    if (!handle) {
      debug("No handle in sessionToken")
      return null
    }

    if (version !== SESSION_TOKEN_VERSION_0) {
      console.log(
        new AuthenticationError("Session token version is not " + SESSION_TOKEN_VERSION_0),
      )
      return null
    }
    debug("(global as any) session config", global.sessionConfig)
    const persistedSession = await global.sessionConfig.getSession(handle)
    if (!persistedSession) {
      debug("Session not found in DB")
      return null
    }
    if (!persistedSession.antiCSRFToken) {
      throw new Error("Internal error: persistedSession.antiCSRFToken is empty")
    }
    if (persistedSession.hashedSessionToken !== hash256(sessionToken)) {
      debug("sessionToken hash did not match")
      debug("persisted: ", persistedSession.hashedSessionToken)
      debug("in req: ", hash256(sessionToken))
      return null
    }
    if (persistedSession.expiresAt && isPast(persistedSession.expiresAt)) {
      debug("Session expired")
      return null
    }
    if (enableCsrfProtection && persistedSession.antiCSRFToken !== antiCSRFToken) {
      if (!antiCSRFToken) {
        console.warn(
          `This request is missing the ${HEADER_CSRF} header. You can learn about adding this here: https://blitzjs.com/docs/session-management#manual-api-requests`,
        )
      }

      headers.set(HEADER_CSRF_ERROR, "true")
      throw new CSRFTokenMismatchError()
    }

    /*
     * Session Renewal - Will renew if any of the following is true
     * 1) publicData has changed
     * 2) 1/4 of expiry time has elasped
     *
     *  But only renew with non-GET requests because a GET request could be from a
     *  browser level navigation
     */
    if (method !== "GET") {
      // The publicData in the DB could have been updated since this client last made
      // a request. If so, then we generate a new access token
      const hasPublicDataChanged =
        hash256(persistedSession.publicData ?? undefined) !== hashedPublicData
      if (hasPublicDataChanged) {
        debug("PublicData has changed since the last request")
      }

      // Check if > 1/4th of the expiry time has passed
      // (since we are doing a rolling expiry window).
      const hasQuarterExpiryTimePassed =
        persistedSession.expiresAt &&
        differenceInMinutes(persistedSession.expiresAt, new Date()) <
          0.75 * (global.sessionConfig.sessionExpiryMinutes as number)

      if (hasQuarterExpiryTimePassed) {
        debug("quarter expiry time has passed")
        debug("Persisted expire time", persistedSession.expiresAt)
      }

      if (hasPublicDataChanged || hasQuarterExpiryTimePassed) {
        await refreshSession(
          headers,
          {
            handle,
            publicData: JSON.parse(persistedSession.publicData || ""),
            jwtPayload: null,
            antiCSRFToken: persistedSession.antiCSRFToken,
            sessionToken,
          },
          {publicDataChanged: hasPublicDataChanged},
        )
      }
    }

    return {
      handle,
      publicData: JSON.parse(persistedSession.publicData || ""),
      jwtPayload: null,
      antiCSRFToken: persistedSession.antiCSRFToken,
      sessionToken,
    }
  } else if (idRefreshToken) {
    // TODO: advanced method
    return null
    // Important: check anonymousSessionToken token as the very last thing
  } else if (anonymousSessionToken) {
    debug("Request has anonymousSessionToken")
    const payload = parseAnonymousSessionToken(anonymousSessionToken)

    if (!payload) {
      debug("Payload empty")
      return null
    }

    if (enableCsrfProtection && payload.antiCSRFToken !== antiCSRFToken) {
      if (!antiCSRFToken) {
        console.warn(
          `This request is missing the ${HEADER_CSRF} header. You can learn about adding this here: https://blitzjs.com/docs/session-management#manual-api-requests`,
        )
      }

      headers.set(HEADER_CSRF_ERROR, "true")
      throw new CSRFTokenMismatchError()
    }

    return {
      handle: payload.handle,
      publicData: payload.publicData,
      antiCSRFToken: payload.antiCSRFToken,
      jwtPayload: payload,
      anonymousSessionToken,
    }
  }

  // No session exists
  return null
}

// --------------------------------
// Create Session
// --------------------------------
interface CreateNewAnonSession {
  headers: Headers
  publicData: EmptyPublicData
  privateData?: Record<any, any>
  anonymous: true
  jwtPayload?: JwtPayload
}
interface CreateNewAuthedSession {
  headers: Headers
  publicData: PublicData
  privateData?: Record<any, any>
  anonymous: false
  jwtPayload?: JwtPayload
}

async function createNewSession(
  args: CreateNewAnonSession | CreateNewAuthedSession,
): Promise<SessionKernel> {
  assert(args.publicData.userId !== undefined, "You must provide publicData.userId")

  const antiCSRFToken = createAntiCSRFToken()

  if (args.anonymous) {
    debug("Creating new anonymous session")
    const handle = generateAnonymousSessionHandle()
    const payload: AnonymousSessionPayload = {
      isAnonymous: true,
      handle,
      publicData: args.publicData,
      antiCSRFToken,
    }
    const anonymousSessionToken = createAnonymousSessionToken(payload)
    const publicDataToken = createPublicDataToken(args.publicData)

    const expiresAt = addMinutes(
      new Date(),
      global.sessionConfig.anonSessionExpiryMinutes as number,
    )
    setAnonymousSessionCookie(args.headers, anonymousSessionToken, expiresAt)
    setCSRFCookie(args.headers, antiCSRFToken, expiresAt)
    setPublicDataCookie(args.headers, publicDataToken, expiresAt)
    // Clear the essential session cookie in case it was previously set
    setSessionCookie(args.headers, "", new Date(0))
    args.headers.set(HEADER_SESSION_CREATED, "true")

    return {
      handle,
      publicData: args.publicData,
      jwtPayload: payload,
      antiCSRFToken,
      anonymousSessionToken,
    }
  } else if (global.sessionConfig.method === "essential") {
    debug("Creating new session")
    const newPublicData: PublicData = {
      // This carries over any public data from the anonymous session
      ...(args.jwtPayload?.publicData || {}),
      ...args.publicData,
    }
    assert(newPublicData.userId, "You must provide a non-empty userId as publicData.userId")

    // This carries over any private data from the anonymous session
    let existingPrivateData = {}
    if (args.jwtPayload?.isAnonymous) {
      const session = await global.sessionConfig.getSession(args.jwtPayload.handle)
      if (session) {
        if (session.privateData) {
          existingPrivateData = JSON.parse(session.privateData)
        }
        // Delete the previous anonymous session
        await global.sessionConfig.deleteSession(args.jwtPayload.handle)
      }
    }

    const newPrivateData: Record<any, any> = {
      ...existingPrivateData,
      ...args.privateData,
    }

    const expiresAt = addMinutes(new Date(), global.sessionConfig.sessionExpiryMinutes as number)
    const handle = generateEssentialSessionHandle()
    const sessionToken = createSessionToken(handle, newPublicData)
    const publicDataToken = createPublicDataToken(newPublicData)

    await global.sessionConfig.createSession({
      expiresAt,
      handle,
      userId: newPublicData.userId,
      hashedSessionToken: hash256(sessionToken),
      antiCSRFToken,
      publicData: JSON.stringify(newPublicData),
      privateData: JSON.stringify(newPrivateData),
    })

    setSessionCookie(args.headers, sessionToken, expiresAt)
    debug("Session created", {handle, publicData: newPublicData, expiresAt})
    setCSRFCookie(args.headers, antiCSRFToken, expiresAt)
    setPublicDataCookie(args.headers, publicDataToken, expiresAt)
    // Clear the anonymous session cookie in case it was previously set
    setAnonymousSessionCookie(args.headers, "", new Date(0))
    args.headers.set(HEADER_SESSION_CREATED, "true")

    return {
      handle,
      publicData: newPublicData,
      jwtPayload: null,
      antiCSRFToken,
      sessionToken,
    }
  } else if (global.sessionConfig.method === "advanced") {
    throw new Error("The advanced method is not yet supported")
  } else {
    throw new Error(
      `Session management method ${global.sessionConfig.method} is invalid. Supported methods are "essential" and "advanced"`,
    )
  }
}

async function createAnonymousSession({headers}: {headers: Headers}) {
  return await createNewSession({
    headers,
    publicData: {userId: null},
    anonymous: true,
  })
}

// --------------------------------
// Session/DB utils
// --------------------------------

async function refreshSession(
  headers: Headers,
  sessionKernel: SessionKernel,
  {publicDataChanged}: {publicDataChanged: boolean},
) {
  debug("Refreshing session", sessionKernel)
  if (sessionKernel.jwtPayload?.isAnonymous) {
    const payload: AnonymousSessionPayload = {
      ...sessionKernel.jwtPayload,
      publicData: sessionKernel.publicData,
    }
    const anonymousSessionToken = createAnonymousSessionToken(payload)
    const publicDataToken = createPublicDataToken(sessionKernel.publicData)

    const expiresAt = addYears(new Date(), 30)
    setAnonymousSessionCookie(headers, anonymousSessionToken, expiresAt)
    setPublicDataCookie(headers, publicDataToken, expiresAt)
  } else if (global.sessionConfig.method === "essential" && "sessionToken" in sessionKernel) {
    const expiresAt = addMinutes(new Date(), global.sessionConfig.sessionExpiryMinutes as number)

    debug("Updating session in db with", {expiresAt})
    if (publicDataChanged) {
      debug("Public data has changed")
      const publicDataToken = createPublicDataToken(sessionKernel.publicData)
      setPublicDataCookie(headers, publicDataToken, expiresAt)
      await global.sessionConfig.updateSession(sessionKernel.handle, {
        expiresAt,
        publicData: JSON.stringify(sessionKernel.publicData),
      })
    } else {
      await global.sessionConfig.updateSession(sessionKernel.handle, {
        expiresAt,
      })
    }
  } else if (global.sessionConfig.method === "advanced") {
    throw new Error("refreshSession() not implemented for advanced method")
  }
}

export async function getAllSessionHandlesForUser(userId: PublicData["userId"]) {
  return (await global.sessionConfig.getSessions(userId)).map((session) => session.handle)
}

async function syncPubicDataFieldsForUserIfNeeded(
  userId: PublicData["userId"],
  data: Record<string, unknown>,
) {
  const dataToSync: Record<string, unknown> = {}
  global.sessionConfig.publicDataKeysToSyncAcrossSessions?.forEach((key: string) => {
    if (data[key]) {
      dataToSync[key] = data[key]
    }
  })
  if (Object.keys(dataToSync).length) {
    const sessions = await global.sessionConfig.getSessions(userId)

    for (const session of sessions) {
      const publicData = JSON.stringify({
        ...(session.publicData ? JSON.parse(session.publicData) : {}),
        ...dataToSync,
      })
      await global.sessionConfig.updateSession(session.handle, {publicData})
    }
  }
}

async function revokeSession(headers: Headers, handle: string, anonymous: boolean = false) {
  debug("Revoking session", handle)
  if (!anonymous) {
    try {
      await global.sessionConfig.deleteSession(handle)
    } catch (error) {
      // Ignore any errors, like if session doesn't exist in DB
    }
  }
  // Go ahead and create a new anon session. This
  // This fixes race condition where all client side queries get refreshed
  // in parallel and each creates a new anon session
  // https://github.com/blitz-js/blitz/issues/2746
  return createAnonymousSession({
    headers,
  })
}

async function revokeAllSessionsForUser(userId: PublicData["userId"]) {
  let sessionHandles = (await global.sessionConfig.getSessions(userId)).map(
    (session) => session.handle,
  )

  let revoked: string[] = []
  for (const handle of sessionHandles) {
    try {
      await global.sessionConfig.deleteSession(handle)
    } catch (error) {
      // Ignore any errors, like if session doesn't exist in DB
    }
    revoked.push(handle)
  }
  return revoked
}

async function getPublicData(sessionKernel: SessionKernel): Promise<PublicData | EmptyPublicData> {
  if (sessionKernel.jwtPayload?.publicData) {
    return sessionKernel.jwtPayload?.publicData
  } else {
    const session = await global.sessionConfig.getSession(sessionKernel.handle)
    if (!session) {
      throw new Error("getPublicData() failed because handle doesn't exist " + sessionKernel.handle)
    }
    if (session.publicData) {
      return JSON.parse(session.publicData) as PublicData
    } else {
      return {} as PublicData
    }
  }
}

async function getPrivateData(handle: string): Promise<Record<any, any> | null> {
  const session = await global.sessionConfig.getSession(handle)
  if (session && session.privateData) {
    return JSON.parse(session.privateData) as Record<any, any>
  } else {
    return null
  }
}

async function setPrivateData(sessionKernel: SessionKernel, data: Record<any, any>) {
  let existingPrivateData = await getPrivateData(sessionKernel.handle)
  if (existingPrivateData === null) {
    // Anonymous sessions may not exist in the DB yet
    try {
      await global.sessionConfig.createSession({
        handle: sessionKernel.handle,
      })
    } catch (error) {}
    existingPrivateData = {}
  }
  const privateData = JSON.stringify({
    ...existingPrivateData,
    ...data,
  })
  await global.sessionConfig.updateSession(sessionKernel.handle, {
    privateData,
  })
}

async function setPublicData(
  headers: Headers,
  sessionKernel: SessionKernel,
  data: Record<any, any>,
) {
  // Don't allow updating userId
  delete data.userId

  const publicData = {
    ...(await getPublicData(sessionKernel)),
    ...data,
  } as PublicData

  await refreshSession(headers, {...sessionKernel, publicData}, {publicDataChanged: true})
  return publicData
}

/**
 * Updates publicData in all sessions
 *
 * @param {PublicData["userId"]} userId
 * @param {Record<any, any>} data
 */
export async function setPublicDataForUser(userId: PublicData["userId"], data: Record<any, any>) {
  // Don't allow updating userId
  delete data.userId

  const sessions = await global.sessionConfig.getSessions(userId)
  for (const session of sessions) {
    // Merge data
    const publicData = JSON.stringify({
      ...JSON.parse(session.publicData || ""),
      ...data,
    })

    await global.sessionConfig.updateSession(session.handle, {publicData})
  }
}

/**
 * Append additional header `field` with value `val`.
 *
 * Example:
 *
 *    append(res, 'Set-Cookie', 'foo=bar; Path=/; HttpOnly');
 *
 * @param {ServerResponse} res
 * @param {string} field
 * @param {string| string[]} val
 */
export function append(res: ServerResponse, field: string, val: string | string[]) {
  let prev: string | string[] | undefined = res.getHeader(field) as string | string[] | undefined
  let value = val

  if (field.toLowerCase() === "set-cookie") {
    const prevCookies = prev ? (Array.isArray(prev) ? prev : [prev]) : []
    const newCookies = Array.isArray(val) ? val : [val]

    const allCookies = [...prevCookies, ...newCookies].reduce((acc: string[], cookieHeader) => {
      return acc.concat(splitCookiesString(cookieHeader))
    }, [])

    const cookieMap = new Map()
    allCookies.forEach((cookieStr) => {
      const firstSemicolon = cookieStr.indexOf(";")
      const cookieNameValue = firstSemicolon > -1 ? cookieStr.slice(0, firstSemicolon) : cookieStr
      const parsed = cookie.parse(cookieNameValue)
      const name = Object.keys(parsed)[0]
      if (name) {
        cookieMap.set(name, cookieStr)
      }
    })

    value = Array.from(cookieMap.values())
  } else if (prev !== undefined) {
    value = Array.isArray(prev)
      ? prev.concat(val)
      : Array.isArray(val)
      ? [prev].concat(val)
      : [prev, val]
  }

  value = Array.isArray(value) ? value.map(String) : String(value)
  res.setHeader(field, value)
  return res
}
