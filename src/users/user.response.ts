import type { User } from './entities/user.entity.js';

export interface UserResponse {
  id: string;
  email: string;
  createdAt: string;
  role: 'user' | 'admin';
  creditBalance: number;
}

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    role: user.role,
    creditBalance: user.creditBalance,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}
