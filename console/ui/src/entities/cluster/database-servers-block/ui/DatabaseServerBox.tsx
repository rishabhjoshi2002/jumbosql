import { FC } from 'react';
import { DatabaseServerBlockProps } from '@entities/cluster/database-servers-block/model/types.ts';
import { Controller, useFormContext } from 'react-hook-form';
import { Card, Checkbox, FormControlLabel, FormGroup, IconButton, Stack, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import CloseIcon from '@mui/icons-material/Close';
import { DATABASE_SERVERS_FIELD_NAMES } from '@entities/cluster/database-servers-block/model/const.ts';
import { HA_ROLE_LABELS, HA_ROLE_ORDER } from '@shared/lib/haInventory.ts';

const DatabaseServerBox: FC<DatabaseServerBlockProps> = ({ index, remove }) => {
  const { t } = useTranslation(['clusters', 'shared']);
  const {
    control,
    formState: { errors },
  } = useFormContext();

  return (
    <Card sx={{ position: 'relative', padding: '16px', minWidth: '240px' }}>
      {remove ? (
        <IconButton sx={{ position: 'absolute', right: '4px', top: '4px', cursor: 'pointer' }} onClick={remove}>
          <CloseIcon />
        </IconButton>
      ) : null}
      <Stack direction="column" gap={1}>
        <Typography fontWeight="bold">{`${t('server', { ns: 'clusters' })} ${index + 1}`}</Typography>
        <Controller
          control={control}
          name={`${DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS}.${index}.${DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME}`}
          render={({ field: { value, onChange } }) => (
            <TextField
              required
              value={value}
              onChange={onChange}
              size="small"
              label={t('hostname', { ns: 'clusters' })}
              error={
                !!errors[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]?.[index]?.[
                  DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME
                ]
              }
              helperText={
                errors?.[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]?.[index]?.[
                  DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME
                ]?.message ?? ' '
              }
            />
          )}
        />
        <Controller
          control={control}
          name={`${DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS}.${index}.${DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS}`}
          render={({ field: { value, onChange } }) => (
            <TextField
              required
              value={value}
              onChange={onChange}
              size="small"
              label={t('ipAddress', { ns: 'clusters' })}
              error={
                !!errors[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]?.[index]?.[
                  DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS
                ]
              }
              helperText={
                errors?.[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]?.[index]?.[
                  DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS
                ]?.message ?? ' '
              }
            />
          )}
        />
        <Controller
          control={control}
          name={`${DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS}.${index}.${DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT}`}
          render={({ field: { value, onChange } }) => (
            <TextField
              value={value}
              onChange={onChange}
              size="small"
              label={t('sshPort', { ns: 'clusters' })}
              error={
                !!errors[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]?.[index]?.[
                  DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT
                ]
              }
              helperText={
                errors?.[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]?.[index]?.[
                  DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT
                ]?.message ?? ' '
              }
            />
          )}
        />
        <Controller
          control={control}
          name={`${DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS}.${index}.${DATABASE_SERVERS_FIELD_NAMES.DATABASE_LOCATION}`}
          render={({ field: { value, onChange } }) => (
            <TextField
              value={value}
              onChange={onChange}
              size="small"
              label={t('location', { ns: 'clusters' })}
              placeholder={t('locationPlaceholder', { ns: 'clusters' })}
            />
          )}
        />
        <Typography variant="body2" fontWeight="bold" marginTop={1}>
          {t('haRoles', { ns: 'clusters' })}
        </Typography>
        <FormGroup>
          {HA_ROLE_ORDER.map((role) => (
            <Controller
              key={role}
              control={control}
              name={`${DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS}.${index}.${DATABASE_SERVERS_FIELD_NAMES.ROLES}.${role}`}
              render={({ field }) => (
                <FormControlLabel
                  sx={{ marginY: '-4px' }}
                  control={<Checkbox size="small" {...field} checked={!!field.value} />}
                  label={<Typography variant="body2">{HA_ROLE_LABELS[role]}</Typography>}
                />
              )}
            />
          ))}
        </FormGroup>
      </Stack>
    </Card>
  );
};

export default DatabaseServerBox;
