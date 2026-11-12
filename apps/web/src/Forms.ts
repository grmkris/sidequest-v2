import { format } from '@sidequest/i18n'
import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import type { Language } from './Language.ts'
import { Problem } from './Problem.ts'
import { say } from './Text.ts'

// What every form shares: where its submission stands, and the checks its fields make before anything is sent.

/** A form being filled in, checked and found wanting, on its way, or refused by the server. */
export const FormStatus = defineTaggedUnion({
  Editing: {},
  Invalid: {},
  Submitting: {},
  Failed: { problem: Problem },
})
export type FormStatus = typeof FormStatus.Type

/** A field changed: the form is being edited again, unless a submission is on its way. */
export const editedStatus = (status: FormStatus): FormStatus =>
  FormStatus.guards.Submitting(status) ? status : FormStatus.Editing()

/** The problem a refused submission met, if it did. */
export const formProblem = (status: FormStatus): Option.Option<Problem> =>
  FormStatus.guards.Failed(status) ? Option.some(status.problem) : Option.none()

/** Field errors show only once a submission found the form wanting. */
const showsErrors = (status: FormStatus): boolean => FormStatus.guards.Invalid(status)

/** What is wrong with a required text of at most `max` characters, as it will be trimmed. */
export const textError = (value: string, max: number, language: Language): Option.Option<string> => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return Option.some(say(language, 'form.required'))
  }
  if (trimmed.length > max) {
    return Option.some(format(language, 'form.tooLong', { max }))
  }
  return Option.none()
}

/** An error, shown only when the form displays its errors. */
export const shown = (status: FormStatus, error: Option.Option<string>): Option.Option<string> =>
  showsErrors(status) ? error : Option.none()

/** The days a person may pick for a period, such as how long a request stays open. */
export const DayChoice = Schema.Literals(['1', '3', '7', '14', '30'])
export type DayChoice = typeof DayChoice.Type
export const dayChoices: ReadonlyArray<DayChoice> = ['1', '3', '7', '14', '30']

/** A day choice from a select's value, if it is one. */
export const dayChoiceOf = (value: string): Option.Option<DayChoice> => Schema.decodeUnknownOption(DayChoice)(value)
