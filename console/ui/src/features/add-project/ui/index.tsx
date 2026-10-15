import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { usePostProjectsMutation } from '@shared/api/api/projects.ts';

import { ProjectFormValues } from '@features/add-project/model/types.ts';
import { toast } from 'react-toastify';
import SettingsAddEntity from '@shared/ui/settings-add-entity/ui';
import { ADD_ENTITY_FORM_NAMES } from '@shared/ui/settings-add-entity/model/constants.ts';

const AddProject: FC = () => {
  const { t } = useTranslation(['settings', 'toasts']);

  const [postProjectTrigger, postProjectTriggerState] = usePostProjectsMutation();

  const onSubmit = async (values: ProjectFormValues) => {
    await postProjectTrigger({
      requestProjectCreate: {
        name: values[ADD_ENTITY_FORM_NAMES.NAME],
        description: values[ADD_ENTITY_FORM_NAMES.DESCRIPTION],
      },
    }).unwrap();
    toast.success(
      t('projectSuccessfullyCreated', {
        ns: 'toasts',
        projectName: values[ADD_ENTITY_FORM_NAMES.NAME],
      }),
    );
  };

  return (
    <SettingsAddEntity
      buttonLabel={t('addProject')}
      headerLabel={t('addProject')}
      submitButtonLabel={t('addProject')}
      nameLabel={t('projectName')}
      isLoading={postProjectTriggerState.isLoading}
      submitTrigger={onSubmit}
    />
  );
};

export default AddProject;
