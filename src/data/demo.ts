import { Question } from '../types';
// Existing technical/STEM courses
import binaire from '../../data/courses/binaire.json';
import booleenne from '../../data/courses/booleenne.json';
import hexadecimal from '../../data/courses/hexadecimal.json';
import mathsBase from '../../data/courses/maths_base.json';
// Culture générale & humanités
import cultureGenerale from '../../data/courses/culture_generale.json';
import histoireFrance from '../../data/courses/histoire_france.json';
import histoireMonde from '../../data/courses/histoire_monde.json';
import geographie from '../../data/courses/geographie.json';
import litterature from '../../data/courses/litterature.json';
import mythologie from '../../data/courses/mythologie.json';
import art from '../../data/courses/art.json';
import cinema from '../../data/courses/cinema.json';
// Sciences & langues
import sciencesBase from '../../data/courses/sciences_base.json';
import astronomie from '../../data/courses/astronomie.json';
import francais from '../../data/courses/francais.json';
import anglais from '../../data/courses/anglais.json';
import technologie from '../../data/courses/technologie.json';

type CourseFile = {
  id: string;
  subject: string;
  description?: string;
  version?: string;
  author?: string;
  questions: Question[];
};

const COURSES: CourseFile[] = [
  // Technique / SIO
  binaire as CourseFile,
  booleenne as CourseFile,
  hexadecimal as CourseFile,
  mathsBase as CourseFile,
  technologie as CourseFile,
  // Sciences
  sciencesBase as CourseFile,
  astronomie as CourseFile,
  // Histoire / géographie
  histoireFrance as CourseFile,
  histoireMonde as CourseFile,
  geographie as CourseFile,
  // Culture & humanités
  cultureGenerale as CourseFile,
  litterature as CourseFile,
  mythologie as CourseFile,
  art as CourseFile,
  cinema as CourseFile,
  // Langues
  francais as CourseFile,
  anglais as CourseFile,
];

export const DEMO_QUESTIONS: Question[] = COURSES.flatMap(c => c.questions);

export const COURSE_META = COURSES.map(({ id, subject, description, version, author }) => ({
  id,
  subject,
  description,
  version,
  author,
}));
