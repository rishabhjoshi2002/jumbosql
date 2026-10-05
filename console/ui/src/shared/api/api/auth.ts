// JumboSQL: sign-in and user management endpoints (see console/service/api/swagger.yaml).
import { baseApi as api } from '../baseApi.ts';

export type ApiUser = {
  id: number;
  username: string;
  display_name?: string;
  role: 'admin' | 'operator' | 'viewer';
  auth_provider?: string;
  created_at?: string;
  last_login_at?: string | null;
};

export type LoginResponse = { token: string; expires_at: string; user: ApiUser };

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Users'] }).injectEndpoints({
  endpoints: (build) => ({
    postAuthLogin: build.mutation<LoginResponse, { username: string; password: string }>({
      query: (body) => ({ url: `/auth/login`, method: 'POST', body }),
    }),
    postAuthLogout: build.mutation<void, void>({
      query: () => ({ url: `/auth/logout`, method: 'POST' }),
    }),
    getAuthMe: build.query<ApiUser, void>({
      query: () => ({ url: `/auth/me` }),
    }),
    postAuthPassword: build.mutation<void, { current_password: string; new_password: string }>({
      query: (body) => ({ url: `/auth/password`, method: 'POST', body }),
    }),
    getUsers: build.query<ApiUser[], void>({
      query: () => ({ url: `/users` }),
      providesTags: ['Users'],
    }),
    postUsers: build.mutation<ApiUser, { username: string; password: string; role: string; display_name?: string }>({
      query: (body) => ({ url: `/users`, method: 'POST', body }),
      invalidatesTags: ['Users'],
    }),
    patchUsersById: build.mutation<ApiUser, { id: number; role?: string; password?: string; display_name?: string }>({
      query: ({ id, ...body }) => ({ url: `/users/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['Users'],
    }),
    deleteUsersById: build.mutation<void, { id: number }>({
      query: ({ id }) => ({ url: `/users/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Users'],
    }),
  }),
  overrideExisting: false,
});

export { injectedRtkApi as authApi };

export const {
  usePostAuthLoginMutation,
  usePostAuthLogoutMutation,
  useGetAuthMeQuery,
  usePostAuthPasswordMutation,
  useGetUsersQuery,
  usePostUsersMutation,
  usePatchUsersByIdMutation,
  useDeleteUsersByIdMutation,
} = injectedRtkApi;
