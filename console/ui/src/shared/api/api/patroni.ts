// JumboSQL: Patroni panel endpoints (see console/service/api/swagger.yaml).
import { baseApi as api } from '../baseApi.ts';

const injectedRtkApi = api.injectEndpoints({
  endpoints: (build) => ({
    postClustersByIdSwitchover: build.mutation<PatroniActionResponse, PostClustersByIdSwitchoverApiArg>({
      query: (queryArg) => ({
        url: `/clusters/${queryArg.id}/switchover`,
        method: 'POST',
        body: queryArg.candidateServerId ? { candidate_server_id: queryArg.candidateServerId } : {},
      }),
      invalidatesTags: (result, error, { id }) => [{ type: 'Clusters', id }],
    }),
    postServersByIdRestart: build.mutation<PatroniActionResponse, ServerActionApiArg>({
      query: (queryArg) => ({ url: `/servers/${queryArg.id}/restart`, method: 'POST' }),
      invalidatesTags: (result, error, { clusterId }) => [{ type: 'Clusters', id: clusterId }],
    }),
    postServersByIdReinitialize: build.mutation<PatroniActionResponse, ServerActionApiArg>({
      query: (queryArg) => ({ url: `/servers/${queryArg.id}/reinitialize`, method: 'POST' }),
      invalidatesTags: (result, error, { clusterId }) => [{ type: 'Clusters', id: clusterId }],
    }),
  }),
  overrideExisting: false,
});

export { injectedRtkApi as patroniApi };

export type PatroniActionResponse = {
  action?: string;
  member?: string;
  message?: string;
};
export type PostClustersByIdSwitchoverApiArg = {
  id: number;
  /** server that becomes the leader; omit to let Patroni choose */
  candidateServerId?: number;
};
export type ServerActionApiArg = {
  id: number;
  /** only used to refresh the right cluster afterwards */
  clusterId?: number | string;
};

export const {
  usePostClustersByIdSwitchoverMutation,
  usePostServersByIdRestartMutation,
  usePostServersByIdReinitializeMutation,
} = injectedRtkApi;
