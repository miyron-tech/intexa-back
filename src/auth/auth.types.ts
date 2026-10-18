export interface AccessTokenPayload {
  /** id пользователя */
  sub: string;
  /** id сессии (refresh-токена) */
  sid: string;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}
