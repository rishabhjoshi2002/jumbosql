// pg_genin: sign-in and user management endpoints (see console/service/api/swagger.yaml).
import { baseApi as api } from '../baseApi.ts';

export type ApiUser = {
  id: number;
  username: string;
  display_name?: string;
  /** legacy: the "group" attribute */
  role?: string;
  attributes?: Record<string, string>;
  /** only from /auth/me */
  permissions?: { global: string[]; clusters: Record<string, string[]> };
  auth_provider?: string;
  created_at?: string;
  last_login_at?: string | null;
  /** from /auth/me and /users: home page (cards, start page; set by an admin) and the user's notes */
  preferences?: UserPreferences;
};

/** pg_genin: personal home page settings, saved per user on the server */
export type UserPreferences = {
  home?: { cards?: string[]; start_page?: string };
  notes?: string;
  [k: string]: unknown;
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
      keepUnusedDataFor: 0,
    }),
    putAuthMePreferences: build.mutation<UserPreferences, UserPreferences>({
      query: (body) => ({ url: `/auth/me/preferences`, method: 'PUT', body }),
    }),
    postAuthPassword: build.mutation<void, { current_password: string; new_password: string }>({
      query: (body) => ({ url: `/auth/password`, method: 'POST', body }),
    }),
    getUsers: build.query<ApiUser[], void>({
      query: () => ({ url: `/users` }),
      providesTags: ['Users'],
    }),
    postUsers: build.mutation<
      ApiUser,
      { username: string; password: string; attributes?: Record<string, string>; display_name?: string }
    >({
      query: (body) => ({ url: `/users`, method: 'POST', body }),
      invalidatesTags: ['Users'],
    }),
    patchUsersById: build.mutation<
      ApiUser,
      {
        id: number;
        attributes?: Record<string, string>;
        password?: string;
        display_name?: string;
        /** pg_genin: the user's home page, set by an admin */
        home?: { cards: string[]; start_page: string };
      }
    >({
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
  usePutAuthMePreferencesMutation,
  useGetUsersQuery,
  usePostUsersMutation,
  usePatchUsersByIdMutation,
  useDeleteUsersByIdMutation,
} = injectedRtkApi;
